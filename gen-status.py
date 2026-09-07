#!/usr/bin/env python3
"""
POC: gera os JSONs lidos pela UI do Proxmox. Roda por cron a cada minuto.

- status.json  : painel da aba "Kubernetes" do nó (nó, pods kube-system, namespaces)
- apps.json    : aplicações Kubernetes (Deployments/StatefulSets/DaemonSets/Jobs/pods
                 soltos) com réplicas, uso e reservas de CPU/memória, containers,
                 serviços, DNS e lista de pods. Consumido por:
                   * Cluster.pm  -> /cluster/resources (tipo 'k8sapp', árvore)
                   * K8sApp.pm   -> /nodes/{node}/k8sapp/{appid}/... (painéis)
- history.json : série temporal por aplicação (CPU/memória/pods/restarts), usada
                 pelo endpoint rrddata para desenhar os mesmos gráficos do guest.

Somente leitura de dados locais; não expõe segredos.
"""
import datetime
import json
import os
import socket
import subprocess
import tempfile

OUT_DIR = "/usr/share/pve-manager/js/k8s"
OUT_STATUS = os.path.join(OUT_DIR, "status.json")
OUT_APPS = os.path.join(OUT_DIR, "apps.json")
OUT_HISTORY = os.path.join(OUT_DIR, "history.json")
K3S = "/usr/local/bin/k3s"
NODENAME = socket.gethostname().split(".")[0]

# 1 amostra/minuto: 1500 amostras ~ 25h (cobre os recortes Hour e Day da UI)
HISTORY_MAX = 1500


def kc_json(*args, timeout=20):
    try:
        r = subprocess.run(
            [K3S, "kubectl", *args], capture_output=True, text=True, timeout=timeout
        )
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def kc_text(*args, timeout=20):
    try:
        r = subprocess.run(
            [K3S, "kubectl", *args], capture_output=True, text=True, timeout=timeout
        )
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


def epoch(ts):
    if not ts:
        return None
    try:
        t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return int(t.timestamp())
    except Exception:
        return None


def age(ts):
    if not ts:
        return "—"
    t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    s = int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds())
    for div, suf in ((86400, "d"), (3600, "h"), (60, "m")):
        if s >= div:
            return f"{s // div}{suf}"
    return f"{s}s"


def memory_gib(quantity):
    if not quantity:
        return None
    units = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40}
    for suffix, factor in units.items():
        if quantity.endswith(suffix):
            return round(float(quantity[: -len(suffix)]) * factor / 1024**3, 1)
    return round(int(quantity) / 1024**3, 1)


def cpu_milli(q):
    """Converte quantity de CPU para milicores (100m -> 100.0, 2 -> 2000.0)."""
    if not q:
        return 0.0
    s = str(q)
    if s.endswith("m"):
        return float(s[:-1])
    if s.endswith("n"):  # nanocores (kubectl top usa 'n' em algumas versões)
        return float(s[:-1]) / 1e6
    if s.endswith("u"):
        return float(s[:-1]) / 1e3
    return float(s) * 1000.0


def mem_bytes(q):
    if not q:
        return 0
    s = str(q)
    mult = {
        "Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "Ti": 2**40,
        "K": 10**3, "M": 10**6, "G": 10**9, "T": 10**12,
    }
    for suf, f in mult.items():
        if s.endswith(suf):
            return int(float(s[: -len(suf)]) * f)
    return int(float(s))


def fmt_cpu(v):
    """v em milicores -> '100m' / '1.5'."""
    if v <= 0:
        return "0"
    if v < 1000:
        return f"{v:.0f}m"
    return f"{round(v / 1000, 2):g}"


def fmt_mem(b):
    if b <= 0:
        return "0"
    mib = b / 2**20
    if mib >= 1024:
        return f"{mib / 1024:.1f}Gi"
    return f"{mib:.0f}Mi"


def write_json(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ---------------------------------------------------------------- status.json
def build_status():
    st = {"generated": datetime.datetime.now().isoformat(timespec="seconds")}

    try:
        v = subprocess.run([K3S, "--version"], capture_output=True, text=True, timeout=10)
        st["version"] = v.stdout.split()[2] if v.returncode == 0 else None
    except Exception:
        st["version"] = None

    nodes_raw = kc_json("get", "nodes", "-o", "json")
    if nodes_raw:
        try:
            nd = nodes_raw["items"][0]
            conds = {c["type"]: c["status"] for c in nd["status"]["conditions"]}
            addrs = {a["type"]: a["address"] for a in nd["status"]["addresses"]}
            ni = nd["status"]["nodeInfo"]
            st["node"] = {
                "name": nd["metadata"]["name"],
                "ready": conds.get("Ready") == "True",
                "internalIP": addrs.get("InternalIP"),
                "hostname": addrs.get("Hostname"),
                "kubelet": ni.get("kubeletVersion"),
                "os": ni.get("osImage"),
                "kernel": ni.get("kernelVersion"),
                "runtime": ni.get("containerRuntimeVersion"),
                "roles": [
                    k.replace("node-role.kubernetes.io/", "")
                    for k in nd["metadata"]["labels"]
                    if k.startswith("node-role.kubernetes.io/")
                ],
                "cpu": nd["status"]["capacity"].get("cpu"),
                "memoryGiB": memory_gib(nd["status"]["capacity"].get("memory")),
            }
        except Exception as e:
            st["node_error"] = str(e)

    pods_raw = kc_json("get", "pods", "-A", "-o", "json")
    if pods_raw:
        try:
            items = pods_raw["items"]
            ns_counts = {}
            sys_pods = []
            for p in items:
                ns = p["metadata"]["namespace"]
                cs = p["status"].get("containerStatuses", [])
                ready = sum(1 for c in cs if c.get("ready"))
                total = len(p["spec"]["containers"])
                restarts = sum(c.get("restartCount", 0) for c in cs)
                phase = p["status"].get("phase", "?")
                a, b = ns_counts.get(ns, (0, 0))
                ns_counts[ns] = (a + ready, b + total)
                if ns == "kube-system":
                    sys_pods.append(
                        {
                            "name": p["metadata"]["name"],
                            "ready": f"{ready}/{total}",
                            "status": phase,
                            "restarts": restarts,
                            "age": age(p["metadata"].get("creationTimestamp")),
                        }
                    )
            st["namespaces"] = {k: f"{v[0]}/{v[1]}" for k, v in sorted(ns_counts.items())}
            st["systemPods"] = sorted(sys_pods, key=lambda x: x["name"])
        except Exception as e:
            st["pods_error"] = str(e)

    write_json(OUT_STATUS, st)


# --------------------------------------------------------------- apoio a apps
def node_capacity():
    """(cpus, bytes de memória) do nó Kubernetes; fallback para o host."""
    nodes = kc_json("get", "nodes", "-o", "json")
    try:
        cap = nodes["items"][0]["status"]["capacity"]
        return float(cap.get("cpu") or 0) or 1.0, mem_bytes(cap.get("memory"))
    except Exception:
        return float(os.cpu_count() or 1), 0


def pod_metrics():
    """{(ns, pod): (milicores, bytes)} via metrics-server; vazio se indisponível."""
    out = kc_text("top", "pods", "-A", "--no-headers")
    res = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            ns, name, cpu, mem = parts[0], parts[1], parts[2], parts[3]
            res[(ns, name)] = (cpu_milli(cpu), mem_bytes(mem))
    return res


def cluster_dns():
    """IP do serviço de DNS do cluster (coredns/kube-dns)."""
    svcs = kc_json("get", "svc", "-n", "kube-system", "-o", "json") or {"items": []}
    for s in svcs.get("items", []):
        if s["metadata"]["name"] in ("kube-dns", "coredns", "rke2-coredns-rke2-coredns"):
            return s.get("spec", {}).get("clusterIP")
    return None


def collect_events():
    """Eventos do cluster agrupados por (namespace, objeto); 'Task History' da UI."""
    raw = kc_json("get", "events", "-A", "-o", "json") or {"items": []}
    byobj = {}
    for e in raw.get("items", []):
        meta = e.get("metadata", {})
        io = e.get("involvedObject", {}) or {}
        ts = e.get("lastTimestamp") or e.get("eventTime") or meta.get("creationTimestamp")
        byobj.setdefault((io.get("namespace"), io.get("name")), []).append(
            {
                "type": e.get("type") or "Normal",
                "reason": e.get("reason") or "?",
                "message": (e.get("message") or "").strip(),
                "count": e.get("count") or 1,
                "ts": epoch(ts),
                "age": age(ts),
                "kind": io.get("kind"),
            }
        )
    for lst in byobj.values():
        lst.sort(key=lambda x: x["ts"] or 0, reverse=True)
    return byobj


def svc_matches(svc, pod_labels):
    sel = (svc.get("spec") or {}).get("selector") or {}
    if not sel:
        return False
    return all(pod_labels.get(k) == v for k, v in sel.items())


def fmt_ports(svc):
    out = []
    for p in (svc.get("spec") or {}).get("ports", []) or []:
        s = f"{p.get('port')}"
        tp = p.get("targetPort")
        if tp is not None and str(tp) != str(p.get("port")):
            s += f"->{tp}"
        if p.get("nodePort"):
            s += f" (node {p['nodePort']})"
        s += f"/{p.get('protocol', 'TCP')}"
        out.append(s)
    return ", ".join(out)


# ------------------------------------------------------------------ apps.json
def build_apps():
    ctrls = kc_json("get", "deployments,statefulsets,daemonsets", "-A", "-o", "json") or {"items": []}
    rs = kc_json("get", "replicasets", "-A", "-o", "json") or {"items": []}
    pods = kc_json("get", "pods", "-A", "-o", "json") or {"items": []}
    svcs = kc_json("get", "svc", "-A", "-o", "json") or {"items": []}

    node_cpus, node_mem = node_capacity()
    metrics = pod_metrics()
    dns_ip = cluster_dns()
    events = collect_events()

    # ReplicaSet -> Deployment controlador (pods apontam para o RS, não para o Deploy)
    rs_owner = {}
    for it in rs.get("items", []):
        ns = it["metadata"]["namespace"]
        name = it["metadata"]["name"]
        for ow in it["metadata"].get("ownerReferences") or []:
            if ow.get("kind") == "Deployment":
                rs_owner[(ns, name)] = ow["name"]

    apps = {}

    def get_app(ns, kind, name):
        key = (ns, kind, name)
        if key not in apps:
            apps[key] = {
                "id": f"k8sapp/{ns}/{name}",
                "appid": f"{ns}:{name}",
                "name": name,
                "namespace": ns,
                "kind": kind,
                "node": NODENAME,
                "replicas": {"desired": 0, "ready": 0},
                "requests": {"cpu": 0.0, "memory": 0},
                "limits": {"cpu": 0.0, "memory": 0},
                "pods": [],
                "containers": [],
                "images": [],
                "volumes": [],
                "services": [],
                "labels": {},
                "annotations": {},
                "spec": {},
                "_restarts": 0,
                "_cpu": 0.0,
                "_mem": 0,
                "_start": None,
                "_podlabels": {},
            }
        return apps[key]

    for it in ctrls.get("items", []):
        ns = it["metadata"]["namespace"]
        name = it["metadata"]["name"]
        kind = it.get("kind", "?")
        app = get_app(ns, kind, name)
        stt = it.get("status", {})
        spec = it.get("spec", {}) or {}
        if kind == "DaemonSet":
            app["replicas"]["desired"] = stt.get("desiredNumberScheduled") or 0
            app["replicas"]["ready"] = stt.get("numberReady") or 0
        else:
            app["replicas"]["desired"] = spec.get("replicas") or 0
            app["replicas"]["ready"] = stt.get("readyReplicas") or 0

        app["labels"] = it["metadata"].get("labels") or {}
        app["annotations"] = {
            k: v
            for k, v in (it["metadata"].get("annotations") or {}).items()
            if k != "kubectl.kubernetes.io/last-applied-configuration"
        }
        pod_spec = ((spec.get("template") or {}).get("spec")) or {}
        strategy = spec.get("strategy") or spec.get("updateStrategy") or {}
        app["spec"] = {
            "strategy": strategy.get("type") or "—",
            "serviceAccount": pod_spec.get("serviceAccountName") or "default",
            "restartPolicy": pod_spec.get("restartPolicy") or "Always",
            "priorityClass": pod_spec.get("priorityClassName") or "—",
            "nodeSelector": ", ".join(
                f"{k}={v}" for k, v in (pod_spec.get("nodeSelector") or {}).items()
            )
            or "—",
            "dnsPolicy": pod_spec.get("dnsPolicy") or "ClusterFirst",
            "hostNetwork": bool(pod_spec.get("hostNetwork")),
            "revision": (it["metadata"].get("annotations") or {}).get(
                "deployment.kubernetes.io/revision"
            ),
            "generation": it["metadata"].get("generation"),
            "creationTimestamp": it["metadata"].get("creationTimestamp"),
        }

    for p in pods.get("items", []):
        meta = p["metadata"]
        ns = meta["namespace"]
        pname = meta["name"]
        kind = aname = None
        owner = (meta.get("ownerReferences") or [None])[0]
        if owner:
            okind = owner.get("kind")
            oname = owner.get("name")
            if okind == "ReplicaSet":
                dep = rs_owner.get((ns, oname))
                if dep:
                    kind, aname = "Deployment", dep
            elif okind in ("Deployment", "StatefulSet", "DaemonSet", "Job"):
                kind, aname = okind, oname
        if not kind:
            kind, aname = "Pod", pname  # pod solto/estático: aparece como aplicação própria
        app = get_app(ns, kind, aname)

        status = p.get("status", {}) or {}
        spec = p.get("spec", {}) or {}
        cs = status.get("containerStatuses", []) or []
        cs_by_name = {c.get("name"): c for c in cs}
        total = len(spec.get("containers", []) or [])
        ready = sum(1 for c in cs if c.get("ready"))
        restarts = sum(c.get("restartCount", 0) for c in cs)
        phase = status.get("phase", "?")

        for c in spec.get("containers", []) or []:
            res = c.get("resources") or {}
            rr = res.get("requests") or {}
            ll = res.get("limits") or {}
            app["requests"]["cpu"] += cpu_milli(rr.get("cpu"))
            app["requests"]["memory"] += mem_bytes(rr.get("memory"))
            app["limits"]["cpu"] += cpu_milli(ll.get("cpu"))
            app["limits"]["memory"] += mem_bytes(ll.get("memory"))
            image = c.get("image") or "—"
            if image not in app["images"]:
                app["images"].append(image)
            cst = cs_by_name.get(c.get("name")) or {}
            state = next(iter((cst.get("state") or {}).keys()), "unknown")
            if not any(x["name"] == c.get("name") for x in app["containers"]):
                app["containers"].append(
                    {
                        "name": c.get("name"),
                        "image": image,
                        "state": state,
                        "ready": bool(cst.get("ready")),
                        "restarts": cst.get("restartCount", 0),
                        "requests": {
                            "cpu": fmt_cpu(cpu_milli(rr.get("cpu"))),
                            "memory": fmt_mem(mem_bytes(rr.get("memory"))),
                        },
                        "limits": {
                            "cpu": fmt_cpu(cpu_milli(ll.get("cpu"))),
                            "memory": fmt_mem(mem_bytes(ll.get("memory"))),
                        },
                    }
                )

        for v in spec.get("volumes", []) or []:
            kinds = [k for k in v.keys() if k != "name"]
            vkind = kinds[0] if kinds else "—"
            detail = ""
            if vkind == "persistentVolumeClaim":
                detail = (v.get(vkind) or {}).get("claimName") or ""
            elif vkind == "configMap":
                detail = (v.get(vkind) or {}).get("name") or ""
            elif vkind == "secret":
                detail = (v.get(vkind) or {}).get("secretName") or ""
            elif vkind == "hostPath":
                detail = (v.get(vkind) or {}).get("path") or ""
            entry = {"name": v.get("name"), "kind": vkind, "detail": detail}
            if entry not in app["volumes"]:
                app["volumes"].append(entry)

        cpu_m, mem_b = metrics.get((ns, pname), (0.0, 0))
        app["_cpu"] += cpu_m
        app["_mem"] += mem_b
        start = epoch(status.get("startTime") or meta.get("creationTimestamp"))
        if start and (app["_start"] is None or start < app["_start"]):
            app["_start"] = start
        app["_podlabels"].update(meta.get("labels") or {})

        app["pods"].append(
            {
                "name": pname,
                "ready": f"{ready}/{total}",
                "status": phase,
                "restarts": restarts,
                "age": age(meta.get("creationTimestamp")),
                "node": spec.get("nodeName") or NODENAME,
                "ip": status.get("podIP") or "—",
                "hostip": status.get("hostIP") or "—",
                "cpu": fmt_cpu(cpu_m),
                "mem": fmt_mem(mem_b),
                "starttime": start,
                "images": [c.get("image") for c in (spec.get("containers") or [])],
            }
        )
        app["_restarts"] += restarts

    # serviços que selecionam os pods da aplicação
    for app in apps.values():
        labels = app["_podlabels"]
        if not labels:
            continue
        for s in svcs.get("items", []):
            if s["metadata"]["namespace"] != app["namespace"]:
                continue
            if not svc_matches(s, labels):
                continue
            sspec = s.get("spec") or {}
            app["services"].append(
                {
                    "name": s["metadata"]["name"],
                    "type": sspec.get("type") or "ClusterIP",
                    "clusterIP": sspec.get("clusterIP") or "—",
                    "ports": fmt_ports(s),
                    "externalIPs": ", ".join(sspec.get("externalIPs") or []) or "—",
                }
            )

    # eventos (Task History): do workload e de cada pod da aplicação
    def obj_events(name, limit=12):
        return (events.get((None, name)) or [])[:limit] + (
            events.get((app_ns, name)) or []
        )[:limit]

    for app in apps.values():
        app_ns = app["namespace"]
        seen = set()
        evs = []
        for ev in obj_events(app["name"]) + [
            e for p in app["pods"] for e in obj_events(p["name"], limit=6)
        ]:
            key = (ev["ts"], ev["type"], ev["reason"], ev["message"])
            if key in seen:
                continue
            seen.add(key)
            evs.append(ev)
        evs.sort(key=lambda x: x["ts"] or 0, reverse=True)
        app["events"] = evs[:60]
        for p in app["pods"]:
            p["events"] = obj_events(p["name"], limit=8)

    now = int(datetime.datetime.now().timestamp())
    out = []
    for a in apps.values():
        d, r = a["replicas"]["desired"], a["replicas"]["ready"]
        if a["kind"] in ("Deployment", "StatefulSet", "DaemonSet"):
            ok = (d == 0 and r == 0) or (d > 0 and r >= d)
        elif a["kind"] == "Pod":
            ok = bool(a["pods"]) and all(p["status"] == "Running" for p in a["pods"])
        else:  # Job e afins
            ok = True
        # escalado a zero = parado de verdade (menu de contexto mostra Start)
        if a["kind"] in ("Deployment", "StatefulSet") and d == 0 and r == 0:
            a["status"] = "stopped"
        else:
            a["status"] = "ok" if ok else "degraded"

        # limites efetivos: o limite declarado ou, sem limite, a capacidade do nó
        lim_cpu_cores = a["limits"]["cpu"] / 1000.0
        lim_mem = a["limits"]["memory"]
        a["cpus"] = round(lim_cpu_cores, 3) if lim_cpu_cores > 0 else node_cpus
        a["maxmem"] = lim_mem if lim_mem > 0 else node_mem
        a["cpucores"] = round(a["_cpu"] / 1000.0, 4)
        a["cpu"] = round(a["cpucores"] / a["cpus"], 6) if a["cpus"] else 0
        a["mem"] = a["_mem"]
        a["uptime"] = max(0, now - a["_start"]) if a["_start"] else 0
        a["podsReady"] = sum(1 for p in a["pods"] if p["status"] == "Running")
        a["podsTotal"] = len(a["pods"])

        a["requestsRaw"] = dict(a["requests"])
        a["limitsRaw"] = dict(a["limits"])
        a["requests"] = {
            "cpu": fmt_cpu(a["requests"]["cpu"]),
            "memory": fmt_mem(a["requests"]["memory"]),
        }
        a["limits"] = {
            "cpu": fmt_cpu(a["limits"]["cpu"]),
            "memory": fmt_mem(a["limits"]["memory"]),
        }
        a["dns"] = {
            "nameserver": dns_ip or "—",
            "policy": a["spec"].get("dnsPolicy", "ClusterFirst"),
            "searchdomain": f"{a['namespace']}.svc.cluster.local svc.cluster.local cluster.local",
            "clusterDomain": "cluster.local",
        }
        a["restarts"] = a.pop("_restarts")
        a.pop("_cpu", None)
        a.pop("_mem", None)
        a.pop("_start", None)
        a.pop("_podlabels", None)
        a["pods"].sort(key=lambda x: x["name"])
        a["services"].sort(key=lambda x: x["name"])
        out.append(a)

    out.sort(key=lambda a: (a["namespace"], a["kind"], a["name"]))
    write_json(
        OUT_APPS,
        {"generated": datetime.datetime.now().isoformat(timespec="seconds"), "apps": out},
    )
    build_history(out, now)
    return len(out)


# --------------------------------------------------------------- history.json
def build_history(apps, now):
    """Série temporal por aplicação, consumida pelo endpoint rrddata."""
    hist = read_json(OUT_HISTORY, {})
    series = hist.get("series") or {}
    alive = set()
    for a in apps:
        key = a["appid"]
        alive.add(key)
        samples = series.get(key) or []
        samples.append(
            [
                now,
                a["cpu"],
                a["cpus"],
                a["mem"],
                a["maxmem"],
                a["podsReady"],
                a["podsTotal"],
                a["restarts"],
            ]
        )
        series[key] = samples[-HISTORY_MAX:]
    for key in list(series):
        if key not in alive:
            del series[key]
    write_json(OUT_HISTORY, {"generated": now, "series": series})


if __name__ == "__main__":
    build_status()
    n = build_apps()
    print(f"ok: {OUT_STATUS} / {OUT_APPS} / {OUT_HISTORY} ({n} apps)")
