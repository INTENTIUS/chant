// Topology Service — maps org slugs to cells.
// Reads config from /etc/topology-service/config.yaml, connects to PostgreSQL,
// serves /healthz, /api/v1/cell_for_org, /api/v1/migrate_org, and /metrics.
// Also acts as topology-cli when invoked via that name.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Database struct {
		Host    string `yaml:"host"`
		Port    int    `yaml:"port"`
		Name    string `yaml:"name"`
		User    string `yaml:"user"`
		SSLMode string `yaml:"sslmode"`
	} `yaml:"database"`
	Server struct {
		Port int `yaml:"port"`
	} `yaml:"server"`
}

type CellResponse struct {
	Cell   string `json:"cell"`
	CellID int    `json:"cell_id"`
}

var db *sql.DB
var cfg *Config

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	// defaults
	c.Database.Port = 5432
	c.Database.SSLMode = "require"
	c.Database.User = "gitlab-topology-db-admin"
	c.Server.Port = 8080
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func connectDB(c *Config) {
	password := os.Getenv("DB_PASSWORD")
	dsn := fmt.Sprintf(
		"host=%s port=%d dbname=%s user=%s password=%s sslmode=%s connect_timeout=5",
		c.Database.Host, c.Database.Port, c.Database.Name, c.Database.User, password, c.Database.SSLMode,
	)

	var err error
	for attempt := 1; attempt <= 10; attempt++ {
		db, err = sql.Open("postgres", dsn)
		if err == nil {
			err = db.Ping()
		}
		if err == nil {
			log.Println("Connected to topology DB")
			initSchema()
			return
		}
		log.Printf("DB connect attempt %d/10 failed: %v", attempt, err)
		time.Sleep(5 * time.Second)
	}
	log.Printf("Warning: running without DB connection — org routing will use default cell: %v", err)
	db = nil
}

func initSchema() {
	if db == nil {
		return
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS cell_assignments (
		org_slug   TEXT PRIMARY KEY,
		cell_name  TEXT    NOT NULL,
		cell_id    INTEGER NOT NULL,
		updated_at TIMESTAMPTZ DEFAULT now()
	)`)
	if err != nil {
		log.Printf("Warning: failed to init schema: %v", err)
	}
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, "ok\n")
}

func handleMetrics(w http.ResponseWriter, _ *http.Request) {
	dbStatus := "0"
	if db != nil && db.Ping() == nil {
		dbStatus = "1"
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "# HELP topology_service_db_up Whether the DB connection is healthy\n")
	fmt.Fprintf(w, "# TYPE topology_service_db_up gauge\n")
	fmt.Fprintf(w, "topology_service_db_up %s\n", dbStatus)
}

func handleCellForOrg(w http.ResponseWriter, r *http.Request) {
	orgSlug := r.URL.Query().Get("org_slug")
	if orgSlug == "" {
		http.Error(w, `{"error":"missing org_slug"}`, http.StatusBadRequest)
		return
	}

	cell := "alpha"
	cellID := 1

	if db != nil {
		var cellName string
		var cID int
		err := db.QueryRow(
			"SELECT cell_name, cell_id FROM cell_assignments WHERE org_slug = $1", orgSlug,
		).Scan(&cellName, &cID)
		if err == nil {
			cell = cellName
			cellID = cID
		}
		// err == sql.ErrNoRows → use defaults (alpha)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CellResponse{Cell: cell, CellID: cellID})
}

type MigrateRequest struct {
	OrgSlug    string `json:"org_slug"`
	TargetCell string `json:"target_cell"`
	CellID     int    `json:"cell_id"`
}

func handleMigrateOrg(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MigrateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if db == nil {
		http.Error(w, "no DB connection", http.StatusServiceUnavailable)
		return
	}
	_, err := db.Exec(`INSERT INTO cell_assignments (org_slug, cell_name, cell_id, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (org_slug) DO UPDATE
		  SET cell_name=EXCLUDED.cell_name, cell_id=EXCLUDED.cell_id, updated_at=now()`,
		req.OrgSlug, req.TargetCell, req.CellID,
	)
	if err != nil {
		http.Error(w, fmt.Sprintf("DB error: %v", err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, `{"status":"ok"}`)
}

func runCLI(args []string) {
	// topology-cli migrate-org --org <org_id_or_slug> --target-cell <cell_name> [--cell-id <n>]
	if len(args) == 0 || args[0] != "migrate-org" {
		fmt.Fprintf(os.Stderr, "Usage: topology-cli migrate-org --org <slug> --target-cell <cell> [--cell-id <n>]\n")
		os.Exit(1)
	}
	var orgSlug, targetCell string
	cellID := 1
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--org":
			i++
			orgSlug = args[i]
		case "--target-cell":
			i++
			targetCell = args[i]
		case "--cell-id":
			i++
			cellID, _ = strconv.Atoi(args[i])
		}
	}
	if orgSlug == "" || targetCell == "" {
		fmt.Fprintln(os.Stderr, "error: --org and --target-cell are required")
		os.Exit(1)
	}

	topologyAddr := os.Getenv("TOPOLOGY_SERVICE_ADDRESS")
	if topologyAddr == "" {
		topologyAddr = "http://localhost:8080"
	}
	body := fmt.Sprintf(`{"org_slug":%q,"target_cell":%q,"cell_id":%d}`, orgSlug, targetCell, cellID)
	resp, err := http.Post(topologyAddr+"/api/v1/migrate_org", "application/json", strings.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error calling topology service: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "topology service error %d: %s\n", resp.StatusCode, respBody)
		os.Exit(1)
	}
	fmt.Printf("Migrated %s to cell %s (id=%d)\n", orgSlug, targetCell, cellID)
}

func main() {
	if filepath.Base(os.Args[0]) == "topology-cli" || (len(os.Args) > 1 && os.Args[1] == "migrate-org") {
		args := os.Args[1:]
		if filepath.Base(os.Args[0]) == "topology-cli" {
			args = os.Args[1:]
		}
		runCLI(args)
		return
	}

	var configPath string
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	} else {
		configPath = "/etc/topology-service/config.yaml"
	}

	var err error
	cfg, err = loadConfig(configPath)
	if err != nil {
		log.Fatalf("Failed to load config from %s: %v", configPath, err)
	}

	go connectDB(cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/metrics", handleMetrics)
	mux.HandleFunc("/api/v1/cell_for_org", handleCellForOrg)
	mux.HandleFunc("/api/v1/migrate_org", handleMigrateOrg)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("topology-service listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
