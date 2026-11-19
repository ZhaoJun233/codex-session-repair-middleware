package engine_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moejs"
)

const requestLimit = 250 * time.Millisecond

var errHookTimeout = errors.New("middleware hook exceeded its host time limit")

type fixture struct {
	Name      string          `json:"name"`
	Body      json.RawMessage `json:"body"`
	Context   json.RawMessage `json:"ctx"`
	Expected  json.RawMessage `json:"expected"`
	ErrorCode string          `json:"errorCode"`
}

type rejection struct {
	Status  int
	Message string
}

type result struct {
	body     []byte
	changed  bool
	rejected *rejection
}

type engine struct {
	rt   *moejs.Runtime
	hook moejs.Hook
}

func packageRoot(t testing.TB) string {
	t.Helper()
	root := os.Getenv("MIDDLEWARE_PACKAGE_DIR")
	if root == "" {
		root = filepath.Join("..", "..")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func newEngine(t testing.TB) *engine {
	t.Helper()
	root := packageRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Main    string          `json:"main"`
		Exports json.RawMessage `json:"exports"`
		Magpie  struct {
			Middleware string `json:"middleware"`
		} `json:"magpie"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Main != "" || len(pkg.Exports) != 0 || pkg.Magpie.Middleware == "" {
		t.Fatal("package must be discoverable as middleware only")
	}
	file := filepath.Join(root, filepath.FromSlash(pkg.Magpie.Middleware))
	src, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := moejs.Compile(file, string(src))
	if err != nil {
		t.Fatal(err)
	}
	// Use Magpie's directory-local module resolution, without importing its host.
	modules := map[string]*moejs.Module{file: entry}
	mod, err := moejs.Link(entry, func(ref moejs.Referrer, spec string) (*moejs.Module, error) {
		if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
			return nil, fmt.Errorf("non-relative import %q", spec)
		}
		from := file
		if ref != nil {
			from = ref.Name()
		}
		path := filepath.Clean(filepath.Join(filepath.Dir(from), filepath.FromSlash(spec)))
		if rel, err := filepath.Rel(root, path); err != nil || strings.HasPrefix(rel, "..") {
			return nil, fmt.Errorf("import %q is outside the middleware package", spec)
		}
		if m, ok := modules[path]; ok {
			return m, nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		m, err := moejs.Compile(path, string(src))
		if err != nil {
			return nil, err
		}
		modules[path] = m
		return m, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rt := moejs.NewRuntime(moejs.Options{})
	if _, err := withLimit(rt, time.Second, func() (moejs.Value, error) {
		return moejs.Undefined(), rt.Load(mod)
	}); err != nil {
		t.Fatal(err)
	}
	hook, err := mod.Hook("onRequest")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := rt.Has(hook); err != nil || !ok {
		t.Fatalf("onRequest not callable: %v", err)
	}
	return &engine{rt: rt, hook: hook}
}

func withLimit(rt *moejs.Runtime, limit time.Duration, call func() (moejs.Value, error)) (moejs.Value, error) {
	done := make(chan struct{})
	timer := time.AfterFunc(limit, func() {
		rt.Interrupt(errHookTimeout)
		close(done)
	})
	v, err := call()
	if !timer.Stop() {
		<-done
		rt.ClearInterrupt()
		return v, errHookTimeout
	}
	rt.ClearInterrupt()
	return v, err
}

func (e *engine) request(body, info []byte) (result, error) {
	defer e.rt.ReleaseCallData()
	ctx, err := e.rt.ParseJSON(info)
	if err != nil {
		return result{}, err
	}
	var rejected *rejection
	realm := e.rt.Realm()
	err = realm.SetV(ctx, realm.KeyFromGoString("reject"), e.rt.Function("reject", 2,
		func(realm *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
			j := rejection{Status: 403, Message: "turned away by a gateway middleware"}
			if a := moejs.Arg(args, 0); a.IsNumber() {
				if n := int(a.AsNumber()); n >= 400 && n <= 599 {
					j.Status = n
				}
			}
			if a := moejs.Arg(args, 1); a.IsString() {
				if s, err := realm.ToString(a); err == nil {
					j.Message = s.GoString()
				}
			}
			if rejected == nil {
				rejected = &j
			}
			return moejs.Undefined(), nil
		}))
	if err != nil {
		return result{}, err
	}
	v, err := e.rt.ParseJSON(body)
	if err != nil {
		return result{}, err
	}
	before, err := e.rt.AppendJSON(nil, v)
	if err != nil {
		return result{}, err
	}
	res, err := withLimit(e.rt, requestLimit, func() (moejs.Value, error) {
		return e.rt.Call(e.hook, v, ctx)
	})
	if err != nil {
		return result{}, err
	}
	after, err := e.rt.AppendJSON(nil, v)
	if err != nil {
		return result{}, err
	}
	if !bytes.Equal(before, after) {
		return result{}, errors.New("middleware mutated its input body")
	}
	if rejected != nil {
		return result{body: body, rejected: rejected}, nil
	}
	if res.IsUndefined() {
		return result{body: body}, nil
	}
	if !res.IsObject() {
		return result{}, errors.New("middleware returned an unsupported hook result")
	}
	out, err := e.rt.AppendJSON(nil, res)
	return result{body: out, changed: true}, err
}

func equalJSON(a, b []byte) bool {
	var av, bv any
	return json.Unmarshal(a, &av) == nil && json.Unmarshal(b, &bv) == nil && reflect.DeepEqual(av, bv)
}

func TestEngineFixtures(t *testing.T) {
	b, err := exec.Command("node", filepath.Join("..", "cases.mjs")).Output()
	if err != nil {
		t.Fatalf("read shared Node fixtures: %v", err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no shared fixtures")
	}
	e := newEngine(t)
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			got, err := e.request(f.Body, f.Context)
			if err != nil {
				t.Fatalf("real middleware engine failed: %v", err)
			}
			if f.ErrorCode != "" {
				if got.rejected == nil || got.rejected.Status != 400 || !strings.HasPrefix(got.rejected.Message, f.ErrorCode+": ") {
					t.Fatalf("expected explicit 400 rejection %s, got %#v", f.ErrorCode, got.rejected)
				}
				if strings.Contains(got.rejected.Message, "synthetic-private-marker") || strings.Contains(got.rejected.Message, "synthetic-sealed") {
					t.Fatal("request data appeared in the rejection message")
				}
				if got.changed || !bytes.Equal(got.body, f.Body) {
					t.Fatal("rejected request should not be replaced or dispatched")
				}
				return
			}
			if got.rejected != nil {
				t.Fatalf("unexpected rejection: %#v", got.rejected)
			}
			if len(f.Expected) == 0 {
				if got.changed || !bytes.Equal(got.body, f.Body) {
					t.Fatal("undefined hook result did not preserve original bytes")
				}
			} else if !got.changed || !equalJSON(got.body, f.Expected) {
				t.Fatalf("replacement differs from fixture:\ngot  %s\nwant %s", got.body, f.Expected)
			}
		})
	}
	t.Logf("ran %d shared synthetic fixtures on moejs v0.1.0", len(fixtures))
}

func TestEngineOriginalBytesAndIdempotency(t *testing.T) {
	e := newEngine(t)
	info := []byte(`{"protocol":"responses","path":"/v1/responses","options":{"enabled":true}}`)
	body := []byte("{\n  \"store\": true,\n  \"input\": [{\"role\":\"user\",\"content\":\"Visible\"}]\n}\n")
	got, err := e.request(body, info)
	if err != nil || got.changed || !bytes.Equal(got.body, body) {
		t.Fatalf("clean body changed: %v", err)
	}
	body = []byte(`{"input":"Visible","previous_response_id":"synthetic-response","store":true}`)
	first, err := e.request(body, info)
	if err != nil || !first.changed {
		t.Fatalf("cleanup failed: %v", err)
	}
	second, err := e.request(first.body, info)
	if err != nil || second.changed || !bytes.Equal(first.body, second.body) {
		t.Fatalf("cleanup not idempotent: %v", err)
	}
}

func TestEngineLargeParsedPlaintext(t *testing.T) {
	e := newEngine(t)
	input := strings.Repeat("\u4e2d", 1_500_000)
	body, err := json.Marshal(map[string]any{"input": input, "previous_response_id": "synthetic-response", "store": true})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	got, err := e.request(body, []byte(`{"protocol":"responses","path":"/v1/responses","options":{"enabled":true}}`))
	if err != nil || !got.changed || got.rejected != nil {
		t.Fatalf("large parsed plaintext failed: %v", err)
	}
	var out struct {
		Input string `json:"input"`
		Store bool   `json:"store"`
	}
	if err := json.Unmarshal(got.body, &out); err != nil || out.Input != input || out.Store {
		t.Fatalf("large parsed plaintext was not preserved: %v", err)
	}
	t.Logf("4.5 MB UTF-8 parsed body completed in %s including test-only mutation checks", time.Since(start))
}

func TestEngineInterruptCanBeCleared(t *testing.T) {
	e := newEngine(t)
	e.rt.Interrupt(errHookTimeout)
	_, err := e.rt.Call(e.hook, moejs.Null(), moejs.Null())
	var interrupted *moejs.InterruptedError
	if !errors.As(err, &interrupted) {
		t.Fatalf("expected engine interrupt, got %v", err)
	}
	e.rt.ClearInterrupt()
	e.rt.ReleaseCallData()
	got, err := e.request([]byte(`{"input":"Visible"}`), []byte(`{"protocol":"responses","path":"/v1/responses","options":{"enabled":false}}`))
	if err != nil || got.changed || got.rejected != nil {
		t.Fatalf("runtime did not recover for a disabled request: %v", err)
	}
}

func BenchmarkRequest(b *testing.B) {
	for _, size := range []int{80 * 1024, 1024 * 1024} {
		b.Run(fmt.Sprintf("%dKiB", size/1024), func(b *testing.B) {
			e := newEngine(b)
			body, err := json.Marshal(map[string]any{"input": strings.Repeat("x", size), "previous_response_id": "synthetic-response", "store": true})
			if err != nil {
				b.Fatal(err)
			}
			info := []byte(`{"protocol":"responses","path":"/v1/responses","options":{"enabled":true}}`)
			b.SetBytes(int64(len(body)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				got, err := e.request(body, info)
				if err != nil || !got.changed || got.rejected != nil {
					b.Fatalf("request failed: %v", err)
				}
			}
		})
	}
}
