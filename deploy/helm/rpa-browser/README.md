# rpa-browser Helm chart

The RPA browser service for n8n workers. Each pod runs the `rpa-browser` image: Playwright's run-server behind the token gate. A pod serves at most `sessionsPerReplica` browser sessions, reports metrics on port 9464, and drains on scale-in. The chart works with Helm 3 and Helm 4 (`apiVersion: v2`).

```sh
kubectl -n rpa create secret generic rpa-browser-token --from-literal=token="$(openssl rand -hex 32)"
helm install rpa-browser deploy/helm/rpa-browser -n rpa \
  --set image.repository=ghcr.io/jb-n8n/rpa-browser --set image.tag=<version> \
  --set token.existingSecret=rpa-browser-token \
  --set n8n.podSelector.app\\.kubernetes\\.io/name=n8n \
  --set 'egress.allowedCIDRs={0.0.0.0/0}' --set 'egress.exceptCIDRs={10.0.0.0/8}'
```

Use the RPA Browser credential in Browser Server mode, with endpoint `ws://<release>.<namespace>.svc.cluster.local:3000/` and the token from the secret.

`values.yaml` documents every value. The sections below are the parts that need a decision, or a check on the first install.

## Drain and eviction

On SIGTERM the gate refuses new sessions and `/healthz` turns 503. The pod exits once its sessions end, or once `drainSeconds` has passed. `terminationGracePeriodSeconds` is `drainSeconds + 30` (630 s by default).

Anything that stops pods has to allow that long:

- **Cluster autoscaler** caps a scale-down eviction at `--max-graceful-termination-sec`, which defaults to 600. That is below the default 630, so a session longer than about 570 s on a node being scaled down is cut off.
  - Set the flag to at least `drainSeconds + 30`.
  - Or keep the cluster autoscaler away from browser nodes, for example with the pod annotation `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` through `podAnnotations`.
- **Node drains** go through the PodDisruptionBudget. Its default, `maxUnavailable: 1`, lets even a single pod be evicted, and the evicted pod still drains for its full grace period. Set `podDisruptionBudget.minAvailable` instead to keep pods serving; with it at or above the pod count, evictions wait.
- **`/tmp`** is an emptyDir with `tmpVolume.sizeLimit` (2Gi by default). It holds Chromium's profiles, downloads and caches. A pod that writes more than the limit is evicted at once, with no drain, and its sessions end. Size the limit for `sessionsPerReplica` browsers and their downloads.

## Scaling

`autoscaling.mode` picks the scaler:

| Mode | Scaler |
|---|---|
| empty (default) | `keda` when `autoscaling.prometheus.serverAddress` is set, `hpa-cpu` otherwise |
| `keda` | KEDA ScaledObject on session utilisation |
| `hpa-cpu` | HorizontalPodAutoscaler on CPU; needs `resources.requests.cpu` |
| `none` | a fixed `replicas` |

KEDA's Prometheus trigger uses this query:

```
sum(rpa_browser_sessions_active{sel} * (1 - rpa_browser_draining{sel}))
  / sum(rpa_browser_sessions_capacity{sel} * (1 - rpa_browser_draining{sel}))
```

- `sel` is `namespace="<namespace>",app_kubernetes_io_instance="<release>"`.
- Draining pods drop out of both the numerator and the denominator.
- `metricType: Value` makes KEDA scale to `ceil(replicas × utilisation / targetUtilization)`.
- `ignoreNullValues: "false"`: if there are no samples, or every pod is draining (0 / 0 gives NaN), KEDA reports an error and keeps the current replica count; it never scales in on missing data.
- `metrics.podMonitor.enabled` writes both labels. If you scrape port 9464 another way, your scrape config must write the same two labels.
- While `networkPolicy.enabled`, `metrics.from` must name your Prometheus pods, or the chart refuses to render: the policy would block the scrape.

## Egress

The NetworkPolicy allows egress only to two kinds of destination:
- cluster DNS on 53: kube-dns, plus `egress.dns.ipBlocks`
- `egress.allowedCIDRs` on 80 and 443

Every allowed CIDR that contains one of these ranges gets it as an `except`. A CIDR inside one of them is refused.

| Range | What it is |
|---|---|
| `169.254.0.0/16` | link-local: the 169.254.169.254 metadata service of AWS, GCP, Azure and OCI; ECS task metadata |
| `fe80::/10` | IPv6 link-local |
| `fd00:ec2::/32` | AWS instance metadata over IPv6 |
| `100.100.100.200/32` | Alibaba Cloud metadata |
| `168.63.129.16/32` | Azure WireServer |
| `fd20:ce::254/128` | GCP metadata over IPv6 |

- **`egress.exceptCIDRs`** cuts more ranges out of every allowed CIDR that contains them. List your VPC, pod and service ranges so that `0.0.0.0/0` doesn't reach n8n, Redis, the database, or other pods listening on 80/443.
- **NodeLocal DNSCache** listens on `169.254.20.10` on every node, and pods that use it send DNS there, not to kube-dns. Add `169.254.20.10/32` to `egress.dns.ipBlocks`. It is the only address inside a metadata range the chart accepts, and only in the DNS rule.
- **Cilium (`egress.fqdns`)** adds a CiliumNetworkPolicy:
  - It allows the listed names on 80 and 443 through Cilium's DNS proxy.
  - It denies the metadata ranges and `egress.exceptCIDRs` on every port, so a name that resolves into them stays blocked.
  - Names are lower case, with one leading `*.` label at most. `*`, `*.*` and `*.<tld>` are refused.
  - **To confirm on a Cilium cluster:** that a deny over the pod range (in `egress.exceptCIDRs`) doesn't also block kube-dns. Cilium's CIDR rules are meant to match only destinations outside the cluster.
- **Enforcement** needs a CNI that enforces NetworkPolicy. On EKS, enable the VPC CNI network policy agent.

## Checks

`tests/render.sh` needs helm, kubeconform and node, plus the network on the first run to fetch schemas. It runs from any directory and checks:
- `helm lint --strict` with four value sets
- kubeconform with the Kubernetes and CRD schemas
- the renders that must fail, each with its message
- `tests/assert.mjs`: the policy facts (metadata ranges, ingress, drain, scalers, token, ports)
