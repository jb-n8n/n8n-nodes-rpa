// Policy facts about the rendered rpa-browser chart. render.sh renders each value set below, converts the output to JSON
// (a Kubernetes List per set) and runs: node assert.mjs <dir with <set>.json>. `node assert.mjs --sets` prints the sets
// (name, release, namespace) so render.sh and these checks share one table. No dependencies: node:test and node:assert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PWUSER_UID = 1001; // pwuser in mcr.microsoft.com/playwright:v1.63.0 (`id pwuser`: uid=1001 gid=1001)
// Ranges the browser may never reach: IPv4 link-local (the 169.254.169.254 metadata service of AWS, GCP, Azure and OCI,
// ECS task metadata), IPv6 link-local, AWS's IPv6 metadata (fd00:ec2::254), Alibaba's metadata, Azure's WireServer and
// GCP's IPv6 metadata. Only NodeLocal DNSCache's 169.254.20.10/32 may appear, and only in the DNS rule (port 53).
const METADATA = ['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::/32', '100.100.100.200/32', '168.63.129.16/32', 'fd20:ce::254/128'];
const NODELOCAL_DNS = '169.254.20.10/32';
const FQDN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GATE_PORT = 3000;
const METRICS_PORT = 9464;

const SETS = [
  {
    name: 'keda', release: 'rpa-browser', namespace: 'rpa', mode: 'keda', drainSeconds: 600, sessions: 4,
    secret: { name: 'rpa-browser-token', key: 'token' },
    n8nPods: { 'app.kubernetes.io/name': 'n8n', 'app.kubernetes.io/component': 'worker' },
    n8nNamespaces: { 'kubernetes.io/metadata.name': 'n8n' },
    metricsFrom: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } } }],
    networkPolicy: true, podMonitor: true, cilium: false, min: 2, max: 12, pdb: { maxUnavailable: 1 },
    exceptCIDRs: ['10.0.0.0/8', '172.16.0.0/12'], dnsIpBlocks: [NODELOCAL_DNS],
    image: 'ghcr.io/example/rpa-browser:1.63.0',
  },
  {
    name: 'hpa', release: 'browsers', namespace: 'automation', mode: 'hpa-cpu', drainSeconds: 900, sessions: 6,
    secret: { name: 'browser-gate', key: 'gate-token' },
    n8nPods: { app: 'n8n-worker' }, n8nNamespaces: null, metricsFrom: [],
    networkPolicy: true, podMonitor: false, cilium: false, min: 1, max: 10, pdb: { maxUnavailable: 1 }, exceptCIDRs: [], dnsIpBlocks: [],
    image: 'ghcr.io/example/rpa-browser@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  {
    name: 'none', release: 'rpa-browser', namespace: 'rpa-e2e', mode: 'none', replicas: 1, drainSeconds: 60, sessions: 1,
    secret: { name: 'rpa-browser-token', key: 'token' },
    networkPolicy: false, podMonitor: false, cilium: false, pdb: { maxUnavailable: 1 },
    image: 'rpa-browser:e2e',
  },
  {
    name: 'cilium', release: 'rpa-browser', namespace: 'rpa', mode: 'hpa-cpu', drainSeconds: 600, sessions: 4,
    secret: { name: 'rpa-browser-token', key: 'token' },
    n8nPods: { 'app.kubernetes.io/name': 'n8n' }, n8nNamespaces: null, metricsFrom: [],
    networkPolicy: true, podMonitor: false, cilium: true, fqdns: ['portal.example.com', '*.sap.example.com'], min: 1, max: 10, pdb: { minAvailable: 2 },
    exceptCIDRs: ['10.0.0.0/8', 'fd00::/8'], dnsIpBlocks: [],
    image: 'ghcr.io/example/rpa-browser:1.63.0@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  },
];

if (process.argv[2] === '--sets') {
  for (const s of SETS) console.log(`${s.name} ${s.release} ${s.namespace}`);
  process.exit(0);
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node assert.mjs <dir with the rendered <set>.json files> | --sets');
  process.exit(2);
}

// --- CIDR arithmetic (BigInt, IPv4 and IPv6) ---------------------------------------------------------------------------
function parseCidr(text) {
  const [addr, bitsText] = String(text).split('/');
  if (addr.includes(':')) {
    const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    assert.equal(groups.length, 8, `bad IPv6 address ${text}`);
    const net = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
    return { family: 6, width: 128n, net, bits: BigInt(bitsText ?? 128) };
  }
  const octets = addr.split('.').map(Number);
  assert.equal(octets.length, 4, `bad IPv4 address ${text}`);
  const net = octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
  return { family: 4, width: 32n, net, bits: BigInt(bitsText ?? 32) };
}

/** True when every address of `inner` lies inside `outer`. */
function cidrContains(outer, inner) {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (o.family !== i.family || i.bits < o.bits) return false;
  const shift = o.width - o.bits;
  return (o.net >> shift) === (i.net >> shift);
}

// --- rendered objects --------------------------------------------------------------------------------------------------
const rendered = Object.fromEntries(SETS.map((s) => [s.name, JSON.parse(readFileSync(join(dir, `${s.name}.json`), 'utf8')).items]));
const ofKind = (items, kind) => items.filter((o) => o.kind === kind);
const one = (items, kind) => {
  const found = ofKind(items, kind);
  assert.equal(found.length, 1, `expected exactly one ${kind}, found ${found.length}`);
  return found[0];
};
const gateContainer = (deployment) => {
  const c = deployment.spec.template.spec.containers;
  assert.equal(c.length, 1, 'the pod runs one container');
  return c[0];
};
const envOf = (container, name) => (container.env ?? []).filter((e) => e.name === name);

for (const set of SETS) {
  const items = rendered[set.name];
  const t = (title, fn) => test(`[${set.name}] ${title}`, fn);

  t('every object is namespaced to the release and named after it', () => {
    for (const o of items) {
      if (o.metadata.namespace !== undefined) assert.equal(o.metadata.namespace, set.namespace, `${o.kind} namespace`);
      assert.ok(o.metadata.name.startsWith(set.release), `${o.kind} ${o.metadata.name} starts with ${set.release}`);
      assert.equal(o.metadata.labels?.['app.kubernetes.io/instance'], set.release, `${o.kind} instance label`);
      assert.equal(o.metadata.labels?.['app.kubernetes.io/name'], 'rpa-browser', `${o.kind} name label`);
    }
    // browser_endpoint = ws://<release>.<namespace>.svc.cluster.local:3000/
    assert.equal(one(items, 'Service').metadata.name, set.release);
    assert.equal(one(items, 'Deployment').metadata.name, set.release);
  });

  t('metadata address is never allowed', () => {
    const policies = ofKind(items, 'NetworkPolicy');
    if (!set.networkPolicy) {
      assert.equal(policies.length, 0, 'networkPolicy.enabled: false renders no NetworkPolicy');
      return;
    }
    assert.equal(policies.length, 1);
    const [np] = policies;
    assert.ok(np.spec.policyTypes.includes('Egress'), 'egress is restricted (Egress in policyTypes)');
    assert.ok(np.spec.policyTypes.includes('Ingress'), 'ingress is restricted (Ingress in policyTypes)');
    for (const rule of np.spec.egress ?? []) {
      assert.ok(Array.isArray(rule.to) && rule.to.length > 0, 'no egress rule allows every destination');
      const dnsOnly = Array.isArray(rule.ports) && rule.ports.length > 0 && rule.ports.every((p) => p.port === 53);
      for (const peer of rule.to) {
        if (!peer.ipBlock) continue;
        const { cidr, except = [] } = peer.ipBlock;
        for (const meta of METADATA) {
          if (cidrContains(meta, cidr)) {
            assert.ok(dnsOnly && cidr === NODELOCAL_DNS, `${cidr} lies inside ${meta}; only ${NODELOCAL_DNS}, on port 53 only, may`);
          } else if (cidrContains(cidr, meta)) {
            assert.ok(except.some((e) => cidrContains(e, meta)), `${cidr} contains ${meta} and must except it (except: ${JSON.stringify(except)})`);
          }
        }
      }
    }
    if (set.cilium) {
      const cnp = one(items, 'CiliumNetworkPolicy');
      // Cilium's deny rules win over every allow, so an FQDN that resolves into one of these ranges is still blocked.
      const denied = (cnp.spec.egressDeny ?? []).flatMap((r) => {
        assert.equal(r.toPorts, undefined, 'the deny covers every port');
        return (r.toCIDRSet ?? []).map((c) => {
          assert.equal(c.except, undefined, 'nothing is cut out of a deny');
          return c.cidr;
        });
      });
      for (const range of [...METADATA, ...set.exceptCIDRs]) assert.ok(denied.includes(range), `the Cilium policy denies ${range}`);
      const fqdns = cnp.spec.egress.flatMap((r) => r.toFQDNs ?? []);
      assert.deepEqual(fqdns.map((f) => f.matchName ?? f.matchPattern), set.fqdns);
      for (const f of fqdns) {
        assert.match(f.matchName ?? f.matchPattern, FQDN_PATTERN, 'no bare or top-level-domain wildcards');
        if (f.matchPattern) assert.ok(f.matchPattern.startsWith('*.') && !f.matchPattern.slice(2).includes('*'), 'one leading wildcard label at most');
      }
      for (const rule of cnp.spec.egress ?? []) {
        assert.equal(rule.toEntities, undefined, 'no Cilium egress to entities (world, all)');
        assert.equal(rule.toCIDR, undefined, 'no Cilium egress to bare CIDRs');
        assert.equal(rule.toCIDRSet, undefined, 'CIDR egress lives in the NetworkPolicy, not the Cilium policy');
        assert.ok(rule.toFQDNs || rule.toEndpoints, 'each Cilium egress rule names FQDNs or endpoints');
      }
    } else {
      assert.equal(ofKind(items, 'CiliumNetworkPolicy').length, 0, 'no Cilium policy without egress.fqdns');
    }
  });

  if (set.networkPolicy) {
    t('every except lies inside its CIDR (Kubernetes rejects one that does not)', () => {
      const np = one(items, 'NetworkPolicy');
      for (const rule of np.spec.egress ?? []) {
        for (const peer of rule.to) {
          for (const e of peer.ipBlock?.except ?? []) {
            assert.ok(cidrContains(peer.ipBlock.cidr, e) && e !== peer.ipBlock.cidr, `${e} inside ${peer.ipBlock.cidr}`);
          }
        }
      }
    });

    t('egress is kube-dns on 53 and the allowed CIDRs on 80/443, nothing else', () => {
      const np = one(items, 'NetworkPolicy');
      const egress = np.spec.egress ?? [];
      const dns = egress.filter((r) => r.ports?.some((p) => p.port === 53));
      assert.equal(dns.length, 1, 'one DNS rule');
      assert.deepEqual(dns[0].ports.map((p) => `${p.protocol}/${p.port}`).sort(), ['TCP/53', 'UDP/53']);
      assert.deepEqual(dns[0].to, [
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } },
        ...set.dnsIpBlocks.map((cidr) => ({ ipBlock: { cidr } })),
      ]);
      for (const r of egress.filter((x) => x !== dns[0])) {
        assert.deepEqual(r.ports.map((p) => `${p.protocol}/${p.port}`).sort(), ['TCP/443', 'TCP/80']);
        assert.ok(r.to.every((p) => p.ipBlock && Object.keys(p).length === 1), 'web egress goes to ipBlocks only');
      }
      if (set.name === 'hpa') {
        const blocks = Object.fromEntries(egress.flatMap((r) => r.to).filter((p) => p.ipBlock).map((p) => [p.ipBlock.cidr, p.ipBlock.except]));
        assert.deepEqual(blocks, {
          '203.0.113.0/24': undefined,
          '168.63.0.0/16': ['168.63.129.16/32'],
          '100.64.0.0/10': ['100.100.100.200/32'],
          '198.51.100.7/32': undefined,
          '::/0': ['fe80::/10', 'fd00:ec2::/32', 'fd20:ce::254/128'],
          '2001:db8::/32': undefined,
          'fd00::/16': ['fd00:ec2::/32'],
        });
      }
      if (set.name === 'keda') {
        const [web] = egress.filter((x) => x !== dns[0]);
        assert.deepEqual(web.to, [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.0.0/16', '100.100.100.200/32', '168.63.129.16/32', '10.0.0.0/8', '172.16.0.0/12'] } }]);
      }
    });

    t('ingress on 3000 only from n8n pods', () => {
      const np = one(items, 'NetworkPolicy');
      const deployment = one(items, 'Deployment');
      assert.deepEqual(np.spec.podSelector.matchLabels, deployment.spec.selector.matchLabels, 'the policy selects the browser pods');
      const ingress = np.spec.ingress ?? [];
      for (const rule of ingress) {
        assert.ok(Array.isArray(rule.from) && rule.from.length > 0, 'no ingress rule allows every source');
        assert.ok(Array.isArray(rule.ports) && rule.ports.length > 0, 'no ingress rule allows every port');
        for (const p of rule.ports) assert.ok([GATE_PORT, METRICS_PORT].includes(p.port) && p.protocol === 'TCP', `port ${p.protocol}/${p.port}`);
        for (const peer of rule.from) assert.equal(peer.ipBlock, undefined, 'no ipBlock sources');
      }
      const gate = ingress.filter((r) => r.ports.some((p) => p.port === GATE_PORT));
      assert.equal(gate.length, 1, 'one rule for the gate port');
      assert.deepEqual(gate[0].ports, [{ port: GATE_PORT, protocol: 'TCP' }], 'the gate rule opens only 3000');
      const expectedPeer = { podSelector: { matchLabels: set.n8nPods } };
      if (set.n8nNamespaces) expectedPeer.namespaceSelector = { matchLabels: set.n8nNamespaces };
      assert.deepEqual(gate[0].from, [expectedPeer]);
      assert.ok(Object.keys(gate[0].from[0].podSelector.matchLabels).length > 0, 'the n8n pod selector is never empty');

      const metrics = ingress.filter((r) => r.ports.some((p) => p.port === METRICS_PORT));
      if (set.metricsFrom.length === 0) {
        assert.equal(metrics.length, 0, 'no metrics.from: nothing may reach 9464');
      } else {
        assert.equal(metrics.length, 1);
        assert.deepEqual(metrics[0].ports, [{ port: METRICS_PORT, protocol: 'TCP' }]);
        assert.deepEqual(metrics[0].from, set.metricsFrom);
      }
      assert.equal(ingress.length, gate.length + metrics.length, 'no other ingress rules');
    });
  }

  t('termination grace covers the drain', () => {
    const deployment = one(items, 'Deployment');
    const pod = deployment.spec.template.spec;
    assert.equal(pod.terminationGracePeriodSeconds, set.drainSeconds + 30);
    assert.deepEqual(envOf(gateContainer(deployment), 'BROWSER_GATE_DRAIN_SECONDS'), [{ name: 'BROWSER_GATE_DRAIN_SECONDS', value: String(set.drainSeconds) }]);
    assert.equal(gateContainer(deployment).lifecycle?.preStop, undefined, 'no preStop hook eats into the drain');
    assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0, 'a rollout never drops serving capacity first');
  });

  t('exactly one scaler per mode', () => {
    const deployment = one(items, 'Deployment');
    const scaled = ofKind(items, 'ScaledObject');
    const hpas = ofKind(items, 'HorizontalPodAutoscaler');
    if (set.mode === 'none') {
      assert.equal(scaled.length + hpas.length, 0);
      assert.equal(deployment.spec.replicas, set.replicas);
      return;
    }
    assert.equal(deployment.spec.replicas, undefined, 'the autoscaler owns the replica count');
    if (set.mode === 'keda') {
      assert.equal(hpas.length, 0, 'KEDA creates its own HPA; the chart renders none');
      const so = one(items, 'ScaledObject');
      assert.deepEqual(so.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name });
      assert.equal(so.spec.minReplicaCount, set.min);
      assert.equal(so.spec.maxReplicaCount, set.max);
      assert.equal(so.spec.triggers.length, 1);
      const [trigger] = so.spec.triggers;
      assert.equal(trigger.type, 'prometheus');
      // Utilisation is a ratio for the whole service: "Value" scales to ceil(replicas * value / target). The default
      // "AverageValue" would divide by the replica count again and never pass two replicas.
      assert.equal(trigger.metricType, 'Value');
      assert.equal(trigger.metadata.threshold, '0.7');
      assert.equal(trigger.metadata.activationThreshold, '0');
      assert.equal(trigger.metadata.serverAddress, 'http://prometheus-operated.monitoring.svc:9090');
      // An empty result is an error that holds the replica count, never a silent 0 that scales in.
      assert.equal(trigger.metadata.ignoreNullValues, 'false');
      // Draining pods count neither their sessions nor their capacity: they are leaving.
      const sel = `{namespace="${set.namespace}",app_kubernetes_io_instance="${set.release}"}`;
      const serving = `(1 - rpa_browser_draining${sel})`;
      assert.equal(trigger.metadata.query, `sum(rpa_browser_sessions_active${sel} * ${serving}) / sum(rpa_browser_sessions_capacity${sel} * ${serving})`);
      assert.deepEqual(trigger.authenticationRef, { name: 'keda-prometheus', kind: 'ClusterTriggerAuthentication' });
    } else {
      assert.equal(scaled.length, 0);
      const hpa = one(items, 'HorizontalPodAutoscaler');
      assert.deepEqual(hpa.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name });
      assert.equal(hpa.spec.minReplicas, set.min);
      assert.equal(hpa.spec.maxReplicas, set.max);
      assert.deepEqual(hpa.spec.metrics, [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }]);
      assert.ok(gateContainer(deployment).resources?.requests?.cpu, 'a CPU HPA needs a CPU request');
    }
  });

  t('the token comes only from the existing secret', () => {
    const deployment = one(items, 'Deployment');
    const c = gateContainer(deployment);
    assert.deepEqual(envOf(c, 'BROWSER_GATE_TOKEN'), [{ name: 'BROWSER_GATE_TOKEN', valueFrom: { secretKeyRef: { name: set.secret.name, key: set.secret.key } } }]);
    assert.equal(c.envFrom, undefined, 'no envFrom');
    assert.equal(ofKind(items, 'Secret').length, 0, 'the chart never creates the secret');
    const refs = JSON.stringify(items).match(/"secretKeyRef":\{[^}]*\}/g) ?? [];
    assert.equal(refs.length, 1, 'the token secret is the only secret the chart reads');
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false, 'no Kubernetes API token in the browser pod');
    assert.equal(deployment.spec.template.spec.enableServiceLinks, false, 'no other services leak in as env');
  });

  t('the metrics port is not on the Service', () => {
    const svc = one(items, 'Service');
    assert.equal(svc.spec.type, 'ClusterIP');
    assert.deepEqual(svc.spec.ports, [{ name: 'gate', port: GATE_PORT, targetPort: 'gate', protocol: 'TCP' }]);
    assert.deepEqual(svc.spec.selector, one(items, 'Deployment').spec.selector.matchLabels);
    for (const kind of ['Ingress', 'Route', 'Gateway', 'HTTPRoute']) assert.equal(ofKind(items, kind).length, 0, `no ${kind}`);
    const ports = gateContainer(one(items, 'Deployment')).ports;
    assert.deepEqual(ports, [{ name: 'gate', containerPort: GATE_PORT, protocol: 'TCP' }, { name: 'metrics', containerPort: METRICS_PORT, protocol: 'TCP' }]);
  });

  t('the gate gets its ports, session limit and probes', () => {
    const c = gateContainer(one(items, 'Deployment'));
    assert.equal(c.image, set.image);
    const env = Object.fromEntries((c.env ?? []).filter((e) => 'value' in e).map((e) => [e.name, e.value]));
    assert.equal(env.BROWSER_GATE_MAX_SESSIONS, String(set.sessions));
    assert.equal(env.BROWSER_GATE_PORT, String(GATE_PORT));
    assert.equal(env.BROWSER_GATE_METRICS_PORT, String(METRICS_PORT));
    assert.equal(env.XDG_CACHE_HOME, '/tmp/.cache', 'caches go to the writable /tmp');
    assert.equal(env.XDG_CONFIG_HOME, '/tmp/.config', 'config goes to the writable /tmp');
    assert.deepEqual(c.readinessProbe.httpGet, { path: '/healthz', port: 'gate' });
    assert.deepEqual(c.livenessProbe.tcpSocket, { port: 'gate' });
    assert.equal(c.livenessProbe.httpGet, undefined, 'liveness is TCP: a draining gate (healthz 503) must not be restarted');
  });

  t('the pod runs as pwuser with no privileges and a read-only root', () => {
    const deployment = one(items, 'Deployment');
    const pod = deployment.spec.template.spec;
    const c = gateContainer(deployment);
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(pod.securityContext.runAsUser, PWUSER_UID);
    assert.equal(pod.securityContext.runAsGroup, PWUSER_UID);
    assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.privileged, false);
    assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] });
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    const tmp = c.volumeMounts.find((m) => m.mountPath === '/tmp');
    assert.ok(tmp, '/tmp is mounted');
    assert.ok(pod.volumes.find((v) => v.name === tmp.name)?.emptyDir, '/tmp is an emptyDir');
    assert.equal(pod.hostNetwork, undefined);
    assert.equal(pod.hostPID, undefined);
  });

  t('the disruption budget keeps a serving pod', () => {
    const pdb = one(items, 'PodDisruptionBudget');
    // maxUnavailable 1 by default: a single pod can still be evicted, and it drains for its full grace period.
    assert.equal(pdb.spec.maxUnavailable, set.pdb.maxUnavailable);
    assert.equal(pdb.spec.minAvailable, set.pdb.minAvailable);
    assert.deepEqual(pdb.spec.selector.matchLabels, one(items, 'Deployment').spec.selector.matchLabels);
  });

  t('the PodMonitor scrapes 9464 and gives the samples the labels the KEDA query selects', () => {
    const monitors = ofKind(items, 'PodMonitor');
    if (!set.podMonitor) {
      assert.equal(monitors.length, 0);
      return;
    }
    const pm = one(items, 'PodMonitor');
    const deployment = one(items, 'Deployment');
    const podLabels = deployment.spec.template.metadata.labels;
    for (const [k, v] of Object.entries(pm.spec.selector.matchLabels)) assert.equal(podLabels[k], v, `the PodMonitor selects the pods (${k})`);
    assert.deepEqual(pm.spec.namespaceSelector, { matchNames: [set.namespace] });
    assert.equal(pm.metadata.labels.release, 'kube-prometheus-stack', 'metrics.podMonitor.labels reach the PodMonitor');
    assert.equal(pm.spec.podMetricsEndpoints.length, 1);
    const [ep] = pm.spec.podMetricsEndpoints;
    assert.equal(ep.port, 'metrics');
    assert.equal(ep.path, '/metrics');
    assert.ok(gateContainer(deployment).ports.some((p) => p.name === 'metrics' && p.containerPort === METRICS_PORT));

    // What each relabeling writes, as the value it takes for this pod.
    const discovered = {
      __meta_kubernetes_namespace: set.namespace,
      ...Object.fromEntries(Object.entries(podLabels).map(([k, v]) => [`__meta_kubernetes_pod_label_${k.replace(/[^a-zA-Z0-9_]/g, '_')}`, v])),
    };
    const labelValues = {};
    for (const r of ep.relabelings ?? []) {
      assert.equal(r.action, 'replace');
      assert.equal(r.sourceLabels.length, 1);
      assert.ok(r.sourceLabels[0] in discovered, `${r.sourceLabels[0]} exists for the pod`);
      labelValues[r.targetLabel] = discovered[r.sourceLabels[0]];
    }
    const query = one(items, 'ScaledObject').spec.triggers[0].metadata.query;
    const matchers = [...query.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)];
    assert.ok(matchers.length >= 4, 'both metrics carry label matchers');
    for (const [, label, value] of matchers) {
      assert.equal(labelValues[label], value, `the query's ${label}="${value}" is what the PodMonitor writes for these pods`);
    }
  });
}
