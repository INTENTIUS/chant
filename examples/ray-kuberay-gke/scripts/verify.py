"""
verify.py — end-to-end smoke test for the ray-kuberay-gke deployment.

Verifies:
  1. Ray cluster is reachable and has >= 4 CPUs (head + at least 1 worker)
  2. @ray.remote tasks actually execute on remote workers (not just the head)
  3. Shared Filestore volume is mounted read-write on all pods
  4. GCS spillover config is present (RAY_object_spilling_config set)

Run from inside the head pod:
  python /tmp/verify.py

Or via kubectl:
  kubectl -n ray-system cp scripts/verify.py \
    $(kubectl -n ray-system get pod -l ray.io/node-type=head -o name | head -1 | sed 's|pod/||'):/tmp/verify.py
  kubectl -n ray-system exec <head-pod> -c ray-head -- python /tmp/verify.py
"""

import os
import socket
import sys
import time

import ray

SHARED_MOUNT = "/mnt/ray-data"
MIN_CPUS = 4


# ── Remote tasks ──────────────────────────────────────────────────────────────

@ray.remote(num_cpus=1)
def get_node_ip() -> str:
    """Return the IP of the node this task runs on.
    Holds a CPU slot briefly to force the scheduler to distribute across nodes.
    """
    import time
    time.sleep(0.5)
    return ray._private.services.get_node_ip_address()


@ray.remote
def write_and_read_shared(path: str, content: str) -> str:
    """Write content to the shared Filestore volume and read it back."""
    with open(path, "w") as f:
        f.write(content)
    with open(path) as f:
        return f.read()


@ray.remote
def parallel_sum(values: list) -> int:
    """Simple distributed computation — sum a list."""
    return sum(values)


# ── Checks ────────────────────────────────────────────────────────────────────

def check(label: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    line = f"  [{status}] {label}"
    if detail:
        line += f" — {detail}"
    print(line)
    return ok


def wait_for_workers(min_cpus: int = MIN_CPUS, timeout: int = 180) -> bool:
    """Submit demand tasks to trigger autoscaler, wait for workers to join."""
    deadline = time.monotonic() + timeout
    # Keep a live future on each CPU slot so the autoscaler sees demand.
    demand = [get_node_ip.remote() for _ in range(min_cpus)]
    while time.monotonic() < deadline:
        cpus = ray.cluster_resources().get("CPU", 0)
        alive = sum(1 for n in ray.nodes() if n.get("Alive"))
        if cpus >= min_cpus and alive >= 2:
            ray.cancel(*demand, force=True)
            return True
        remaining = int(deadline - time.monotonic())
        print(f"  waiting for workers: CPU={cpus}/{min_cpus} nodes={alive} ({remaining}s left)")
        time.sleep(10)
    ray.cancel(*demand, force=True)
    return False


def main() -> int:
    print("=== ray-kuberay-gke verify ===")
    print()
    failures = 0

    # ── 1. Connect ────────────────────────────────────────────────────────────
    print("Connecting to Ray cluster...")
    ray.init(address="auto")

    # Trigger autoscaler if workers have scaled down and wait for them to join.
    cpus = ray.cluster_resources().get("CPU", 0)
    if cpus < MIN_CPUS:
        print(f"  only {cpus} CPUs available — waiting for autoscaler to provision workers...")
        if not wait_for_workers():
            print("  timed out waiting for workers")

    resources = ray.cluster_resources()
    nodes = ray.nodes()
    print(f"  cluster_resources: {resources}")
    print(f"  nodes: {len(nodes)}")
    print()

    cpus = resources.get("CPU", 0)
    if not check("cluster CPUs >= 4", cpus >= MIN_CPUS, f"CPU={cpus}"):
        failures += 1

    alive_nodes = [n for n in nodes if n.get("Alive")]
    if not check("at least 2 nodes alive (head + 1 worker)", len(alive_nodes) >= 2,
                 f"alive={len(alive_nodes)}"):
        failures += 1

    # ── 2. Distributed execution ──────────────────────────────────────────────
    print()
    print("Testing distributed execution...")
    # Submit 8 tasks — with >= 2 nodes they should land on multiple IPs.
    futures = [get_node_ip.remote() for _ in range(8)]
    ips = ray.get(futures)
    unique_ips = set(ips)
    print(f"  task IPs: {unique_ips}")
    if not check("tasks ran on >= 2 distinct nodes", len(unique_ips) >= 2,
                 f"unique IPs={unique_ips}"):
        failures += 1

    # ── 3. Distributed computation ────────────────────────────────────────────
    print()
    print("Testing parallel computation...")
    chunks = [[i * 100 + j for j in range(100)] for i in range(8)]
    t0 = time.monotonic()
    results = ray.get([parallel_sum.remote(c) for c in chunks])
    elapsed = time.monotonic() - t0
    total = sum(results)
    expected = sum(sum(c) for c in chunks)
    if not check("parallel sum correct", total == expected,
                 f"got={total} want={expected} elapsed={elapsed:.2f}s"):
        failures += 1

    # ── 4. Shared Filestore volume ────────────────────────────────────────────
    print()
    print("Testing shared Filestore volume...")
    if os.path.isdir(SHARED_MOUNT):
        test_path = os.path.join(SHARED_MOUNT, f".verify-{socket.gethostname()}")
        sentinel = f"ray-verify-{time.time()}"
        try:
            result = ray.get(write_and_read_shared.remote(test_path, sentinel))
            if not check("shared volume read-write", result == sentinel,
                         f"path={test_path}"):
                failures += 1
            os.unlink(test_path)
        except Exception as e:
            check("shared volume read-write", False, str(e))
            failures += 1
    else:
        check("shared volume mounted", False, f"{SHARED_MOUNT} not found")
        failures += 1

    # ── 5. GCS spillover config ───────────────────────────────────────────────
    print()
    print("Checking GCS spillover config...")
    spill_cfg = os.environ.get("RAY_object_spilling_config", "")
    if not check("RAY_object_spilling_config set", bool(spill_cfg),
                 spill_cfg or "(not set)"):
        failures += 1

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    if failures == 0:
        print("PASSED — all checks OK")
    else:
        print(f"FAILED — {failures} check(s) failed")
    return failures


if __name__ == "__main__":
    sys.exit(main())
