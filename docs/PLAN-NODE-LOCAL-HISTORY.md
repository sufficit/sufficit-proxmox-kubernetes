# Plan: node-local history in RRD, live state on demand

Date: 2026-11-13. Status: phase 1 running (collector in parallel since 2026-11-13 18:40 BRT). Owner decision: each PVE node produces its own data; the UI must not
depend on VictoriaMetrics or on any other node to draw its own graphs.

## Problem (measured 2026-11-13)

`gen-status.py` runs from cron every minute on **every** PVE node (eveo, apoint, castrum) and each run:

- queries the **whole cluster** through the apiserver (`get pods -A`, `events -A`, `deployments,statefulsets,daemonsets -A`,
  `replicasets -A`, `svc -A`, `nodes`, `top pods -A`): the same load three times per minute;
- rewrites `history.json` (12 MB, was 22 MB) and `pod-history.json` (5.5 MB) entirely, each node keeping its own copy
  of the time series of the whole cluster;
- cost on eveo-cloud: 7.6 s wall / 11 s CPU per run after the compact-JSON fix (10.4 s / 13.8 s before);
  apoint ~4.5 s CPU, castrum ~4.1 s CPU.

Nobody looks at the panel most of the time, yet everything is produced every minute.

Rejected alternative: read history from VictoriaMetrics (it already has cadvisor, kubelet and kube-state-metrics).
VictoriaMetrics runs only on eveo; if it is down, every node loses its graphs.

## Target design

### History: node-local RRD, same machinery as PVE guests

- A collector on each node reads **only its own node** from the local kubelet (`/api/v1/nodes/<node>/proxy/stats/summary`
  or `/metrics/resource`): CPU, memory and ephemeral disk per pod running on this node. No cluster-wide list.
- Writes through the `rrdcached` that PVE already runs, into `/var/lib/rrdcached/db/pve-k8s-1.0/`:
  - `node` : aggregate of this node's pods (today `node-history.json`);
  - `pod/<namespace>/<pod>` : per pod (today `pod-history.json`);
  - `app/<namespace>/<name>` : this node's share of each application (today `history.json`).
- RRD files use the same RRAs as `pve-vm-9.0` (1 min for a day, 30 min for a month, 6 h for a year), fixed size,
  constant-cost updates; no more rewriting megabytes per minute.
- Endpoints `rrddata`, `podrrddata` and `noderrddata` in `k8sapp.pm` read with `PVE::RRD::create_rrd_data(...)`, the
  same reader the native guest graphs use (it accepts any name under `/var/lib/rrdcached/db/`).
- An application with pods on several nodes: the panel asks each node that hosts a pod
  (`/nodes/{n}/k8sapp/{appid}/rrddata`, proxied by pveproxy) and sums the series. A node down only removes its share.
- Garbage collection: RRD files untouched for 30 days are removed by the collector.

### Live state: on demand with a short cache

- `apps.json`/`status.json` stop being produced by cron. The `k8sapp` endpoints (and `Cluster.pm` for the resource
  tree) call the apiserver when asked and keep the result in a per-node cache file for 30 s.
- The resource tree polls `/cluster/resources` every few seconds while the UI is open: the 30 s cache bounds the
  apiserver load to at most 2 calls per minute per node, and zero when no one has the UI open.
- If the apiserver is down the panel shows the cached snapshot with its age.

### Collector cadence

- systemd timer every 60 s (instead of cron), `Nice=10`, `CPUQuota=20%`; only local kubelet reads + `rrdtool update`
  through the rrdcached socket. Target: < 0.5 s CPU per run.

## Phases (each validated on one node first, then the other two)

0. **Done 2026-11-13:** compact JSON in `write_json` (repo and the 3 nodes).
1. Collector `k8s-rrd-collect` (node-local, RRD) running **in parallel** with the current cron; compare series for
   24 h against `node-history.json`.
   - **Installed 2026-11-13 on eveo, apoint, castrum** (manual: `/usr/local/sbin/k8s-rrd-collect`,
     `k8s-rrd-collect.timer` at :30 of every minute). Cost per run: eveo 0.17 s CPU (62 pods), apoint/castrum
     0.06 s (20-21 pods), against 4-11 s for `gen-status.py`. Disk: eveo 69 MB (125 files), apoint/castrum ~24 MB.
   - Data comes from the local kubelet (`https://127.0.0.1:10250/stats/summary` and `/pods`, apiserver client cert
     from `/var/lib/rancher/k3s/server/tls`), so it works with the apiserver down.
   - Design change: CPU and network are **rates computed per pod** against the previous run (state in
     `/run/k8s-rrd-collect.state.json`) and stored as GAUGE (`cores`, `netin`, `netout`). Summing cumulative counters
     per app/node would give a negative step or a spike whenever a pod appears or disappears.
   - Network (`netin`/`netout`) is new: today's graphs show 0. hostNetwork pods are skipped (they would report host
     interfaces).
   - App mapping without the apiserver: Deployment name = ReplicaSet name minus `-<pod-template-hash>`.
   - Gate to phase 2: 24 h of samples without errors in `journalctl -u k8s-rrd-collect`, node series matching
     `node-history.json` (CPU and memory).
2. Switch `noderrddata`/`podrrddata`/`rrddata` to RRD; per-app fan-out in `app-browser.js`; Playwright specs
   `node-usage.spec.js` and `pods-in-tree.spec.js` updated.
3. Live state on demand + 30 s cache; remove `history.json`, `pod-history.json`, `node-history.json` and the cron
   from `patch_ui.py`/`manage.sh` (`manage.sh` checks updated).
4. Measure again on the 3 nodes (CPU per minute, apiserver request rate) and record in an activity.

## Findings to resolve along the way

- Production `K8sApp.pm` (identical md5 on the 3 nodes) lacks the `noderrddata` endpoint from #16 while
  `gen-status.py` is current: the last install did not redeploy `k8sapp.pm`. Redeploy with `manage.sh` in phase 2.
- apoint had 18 empty `.tmp-*` files in `/usr/share/pve-manager/js/k8s/` left by runs killed mid-write; cleaned on
  2026-11-13. The collector must remove its temp file on failure.

## Rollback

Each phase keeps the previous path until the next phase is validated; phase 3 is the only removal and is reverted by
reinstalling the previous release with `manage.sh`.
