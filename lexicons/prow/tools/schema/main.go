// Prints the job-level fields of Prow's job config types (Presubmit,
// Postsubmit, Periodic and the structs they embed) as JSON, read by
// reflection from sigs.k8s.io/prow at the version ../go.mod pins, with each
// field's doc comment from pkg/config/jobs.go. src/spec/vendor.ts joins it
// with the ProwJob CRD into src/spec/job-config.schema.json.
//
//	go run ./schema <sigs.k8s.io/prow module dir>
//
// A field whose type the ProwJob CRD also carries (the pod spec, the
// decoration config, refs, the reporter and rerun configs) is written as a
// reference to that type by name, and vendor.ts takes its schema from the
// CRD, so the two never disagree.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"sigs.k8s.io/prow/pkg/config"
)

type field struct {
	Key         string `json:"key"`
	Type        any    `json:"type"`
	Description string `json:"description,omitempty"`
}

type kind struct {
	Name   string  `json:"name"`
	Fields []field `json:"fields"`
}

// What the CRD carries, by Go type name: vendor.ts maps each to the ProwJob spec property of the same shape.
var crd = map[string]bool{
	"PodSpec": true, "DecorationConfig": true, "Refs": true, "ReporterConfig": true,
	"RerunAuthConfig": true, "ProwJobDefault": true, "PipelineRunSpec": true, "TektonPipelineRunSpec": true,
}

var docs = map[string]string{}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./schema <sigs.k8s.io/prow module dir>")
		os.Exit(2)
	}
	readDocs(filepath.Join(os.Args[1], "pkg", "config", "jobs.go"))
	defs := map[string][]field{}
	out := map[string]any{
		"kinds": []kind{
			{"Presubmit", fields(reflect.TypeOf(config.Presubmit{}), "Presubmit", defs)},
			{"Postsubmit", fields(reflect.TypeOf(config.Postsubmit{}), "Postsubmit", defs)},
			{"Periodic", fields(reflect.TypeOf(config.Periodic{}), "Periodic", defs)},
		},
		"definitions": defs,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// readDocs keeps each struct field's doc comment, keyed "Struct.Field".
func readDocs(path string) {
	f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ast.Inspect(f, func(n ast.Node) bool {
		ts, ok := n.(*ast.TypeSpec)
		if !ok {
			return true
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			return true
		}
		for _, fl := range st.Fields.List {
			if fl.Doc == nil {
				continue
			}
			text := strings.Join(strings.Fields(fl.Doc.Text()), " ")
			for _, name := range fl.Names {
				docs[ts.Name.Name+"."+name.Name] = text
			}
		}
		return false
	})
}

func fields(t reflect.Type, owner string, defs map[string][]field) []field {
	var out []field
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if f.Anonymous && tag == "" {
			out = append(out, fields(f.Type, f.Type.Name(), defs)...)
			continue
		}
		if !f.IsExported() || tag == "-" {
			continue
		}
		key := strings.Split(tag, ",")[0]
		if key == "" {
			key = f.Name
		}
		out = append(out, field{Key: key, Type: typeOf(f.Type, defs), Description: docs[owner+"."+f.Name]})
	}
	return out
}

func typeOf(t reflect.Type, defs map[string][]field) any {
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint32, reflect.Uint64:
		return "integer"
	case reflect.Slice:
		return map[string]any{"array": typeOf(t.Elem(), defs)}
	case reflect.Map:
		return map[string]any{"map": typeOf(t.Elem(), defs)}
	case reflect.Struct:
		name := t.Name()
		if !crd[name] {
			if _, seen := defs[name]; !seen {
				defs[name] = nil
				defs[name] = fields(t, name, defs)
			}
		}
		return map[string]any{"ref": name}
	}
	return "any"
}
