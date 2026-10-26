{{/* The chart name, for the app.kubernetes.io/name label. */}}
{{- define "rpa-browser.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Every object is named after the release (fullnameOverride aside), so the Service DNS name is
<release>.<namespace>.svc.cluster.local, the endpoint the Terraform module outputs.
*/}}
{{- define "rpa-browser.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rpa-browser.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rpa-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rpa-browser.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "rpa-browser.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: browser
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rpa-browser.image" -}}
{{- $repo := required "image.repository is required (for example ghcr.io/jb-n8n/rpa-browser)" .Values.image.repository -}}
{{- if and (empty .Values.image.tag) (empty .Values.image.digest) -}}
{{- fail "image.tag or image.digest is required" -}}
{{- end -}}
{{- $repo -}}
{{- with .Values.image.tag }}:{{ . }}{{ end -}}
{{- with .Values.image.digest }}@{{ . }}{{ end -}}
{{- end -}}

{{/* keda, hpa-cpu or none. Empty mode: keda when a Prometheus address is set, hpa-cpu otherwise. */}}
{{- define "rpa-browser.autoscalingMode" -}}
{{- $a := .Values.autoscaling -}}
{{- $mode := $a.mode | default (ternary "keda" "hpa-cpu" (not (empty $a.prometheus.serverAddress))) -}}
{{- if not (has $mode (list "keda" "hpa-cpu" "none")) -}}
{{- fail (printf "autoscaling.mode must be keda, hpa-cpu or none (got %q)" $mode) -}}
{{- end -}}
{{- if and (eq $mode "keda") (empty $a.prometheus.serverAddress) -}}
{{- fail "autoscaling.mode keda needs autoscaling.prometheus.serverAddress (or use hpa-cpu or none)" -}}
{{- end -}}
{{- if and (eq $mode "hpa-cpu") (empty (dig "requests" "cpu" "" (.Values.resources | default dict))) -}}
{{- fail "autoscaling.mode hpa-cpu needs resources.requests.cpu (CPU utilisation is measured against the request)" -}}
{{- end -}}
{{- $mode -}}
{{- end -}}

{{/*
Session utilisation for this release, without the draining pods: a pod shutting down counts neither its sessions nor
its capacity (rpa_browser_draining is 1 there). The three gauges come from the same scrape target, so they carry the
same labels and match one to one. The labels are the ones the PodMonitor writes (namespace and
app_kubernetes_io_instance); a scrape config of your own must write the same. If every pod is draining the denominator
is 0 and the result NaN: KEDA reports an error and the replica count holds.
*/}}
{{- define "rpa-browser.utilisationQuery" -}}
{{- $sel := printf "{namespace=%q,app_kubernetes_io_instance=%q}" .Release.Namespace .Release.Name -}}
{{- $serving := printf "(1 - rpa_browser_draining%s)" $sel -}}
{{- printf "sum(rpa_browser_sessions_active%s * %s) / sum(rpa_browser_sessions_capacity%s * %s)" $sel $serving $sel $serving -}}
{{- end -}}

{{/* One hex group (1-4 digits, lower case) as an integer. */}}
{{- define "rpa-browser.hex16" -}}
{{- $digits := dict "0" 0 "1" 1 "2" 2 "3" 3 "4" 4 "5" 5 "6" 6 "7" 7 "8" 8 "9" 9 "a" 10 "b" 11 "c" 12 "d" 13 "e" 14 "f" 15 -}}
{{- $v := 0 -}}
{{- range splitList "" . }}{{ $v = add (mul $v 16) (get $digits .) }}{{ end -}}
{{- $v -}}
{{- end -}}

{{/*
A CIDR as JSON {"family": 4|6, "bits": prefix, "groups": [16-bit integers]} (2 groups for IPv4, 8 for IPv6). Fails on
anything else, so a typo never turns into a wider rule.
*/}}
{{- define "rpa-browser.parseCidr" -}}
{{- $cidr := toString . | lower -}}
{{- $bad := printf "%q is not an IPv4 or IPv6 CIDR (address/prefix)" (toString .) -}}
{{- $parts := splitList "/" $cidr -}}
{{- if or (ne (len $parts) 2) (not (regexMatch "^[0-9]{1,3}$" (index $parts 1))) }}{{ fail $bad }}{{ end -}}
{{- $addr := index $parts 0 -}}
{{- $bits := atoi (index $parts 1) -}}
{{- if regexMatch "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$" $addr -}}
  {{- if gt $bits 32 }}{{ fail $bad }}{{ end -}}
  {{- $o := list -}}
  {{- range splitList "." $addr }}{{ if gt (atoi .) 255 }}{{ fail $bad }}{{ end }}{{ $o = append $o (atoi .) }}{{ end -}}
  {{- dict "family" 4 "bits" $bits "groups" (list (add (mul (index $o 0) 256) (index $o 1)) (add (mul (index $o 2) 256) (index $o 3))) | toJson -}}
{{- else if regexMatch "^[0-9a-f:]+$" $addr -}}
  {{- if gt $bits 128 }}{{ fail $bad }}{{ end -}}
  {{- $halves := splitList "::" $addr -}}
  {{- if gt (len $halves) 2 }}{{ fail $bad }}{{ end -}}
  {{- $head := list }}{{ with index $halves 0 }}{{ $head = splitList ":" . }}{{ end -}}
  {{- $tail := list }}{{ if eq (len $halves) 2 }}{{ with index $halves 1 }}{{ $tail = splitList ":" . }}{{ end }}{{ end -}}
  {{- $missing := sub 8 (add (len $head) (len $tail)) | int -}}
  {{- if or (and (eq (len $halves) 1) (ne $missing 0)) (and (eq (len $halves) 2) (lt $missing 1)) }}{{ fail $bad }}{{ end -}}
  {{- $groups := list -}}
  {{- range $head }}{{ if not (regexMatch "^[0-9a-f]{1,4}$" .) }}{{ fail $bad }}{{ end }}{{ $groups = append $groups (include "rpa-browser.hex16" . | atoi) }}{{ end -}}
  {{- range until $missing }}{{ $groups = append $groups 0 }}{{ end -}}
  {{- range $tail }}{{ if not (regexMatch "^[0-9a-f]{1,4}$" .) }}{{ fail $bad }}{{ end }}{{ $groups = append $groups (include "rpa-browser.hex16" . | atoi) }}{{ end -}}
  {{- dict "family" 6 "bits" $bits "groups" $groups | toJson -}}
{{- else -}}
  {{- fail $bad -}}
{{- end -}}
{{- end -}}

{{/* "true" when every address of .inner lies inside .outer (both CIDRs), else empty. */}}
{{- define "rpa-browser.cidrContains" -}}
{{- $o := include "rpa-browser.parseCidr" .outer | fromJson -}}
{{- $i := include "rpa-browser.parseCidr" .inner | fromJson -}}
{{- if and (eq (int $o.family) (int $i.family)) (ge (int $i.bits) (int $o.bits)) -}}
  {{- $same := true -}}
  {{- $left := int $o.bits -}}
  {{- range $k, $og := $o.groups -}}
    {{- $take := min 16 (max 0 $left) | int -}}
    {{- if gt $take 0 -}}
      {{- $block := 1 }}{{ range until (sub 16 $take | int) }}{{ $block = mul $block 2 }}{{ end -}}
      {{- if ne (div (int $og) $block | int) (div (int (index $i.groups $k)) $block | int) }}{{ $same = false }}{{ end -}}
    {{- end -}}
    {{- $left = sub $left 16 | int -}}
  {{- end -}}
  {{- if $same }}true{{ end -}}
{{- end -}}
{{- end -}}

{{/*
The ranges the browser may never reach, as a JSON list: IPv4 link-local (the 169.254.169.254 metadata service of AWS,
GCP, Azure and OCI; ECS task metadata), IPv6 link-local, AWS's IPv6 metadata (fd00:ec2::254), Alibaba's metadata,
Azure's WireServer, GCP's IPv6 metadata.
*/}}
{{- define "rpa-browser.metadataRanges" -}}
{{- list "169.254.0.0/16" "fe80::/10" "fd00:ec2::/32" "100.100.100.200/32" "168.63.129.16/32" "fd20:ce::254/128" | toJson -}}
{{- end -}}

{{/* "*.example.com" or "portal.example.com"; never "*", "*.*" or "*.<tld>". values.schema.json has the same pattern. */}}
{{- define "rpa-browser.fqdnPattern" -}}
^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$
{{- end -}}

{{/*
ipBlock peers as a YAML list, for a dict of root, cidrs, excepts, what (the value name, for messages) and allowInside.
The metadata ranges, then the excepts, are cut out of each CIDR that contains them. Kubernetes requires every except to
lie inside its CIDR, so a CIDR that doesn't contain a range gets no except for it (and can't reach it anyway). A CIDR
inside a metadata range or inside an except is refused, unless it is listed in allowInside (only NodeLocal DNSCache's
169.254.20.10/32, and only for the DNS rule).
*/}}
{{- define "rpa-browser.ipBlocks" -}}
{{- $metadata := include "rpa-browser.metadataRanges" .root | fromJsonArray -}}
{{- $peers := list -}}
{{- range $cidr := .cidrs -}}
  {{- $except := list -}}
  {{- if has (toString $cidr) $.allowInside -}}
    {{- $_ := include "rpa-browser.parseCidr" $cidr -}}
  {{- else -}}
    {{- range $e := uniq (concat $metadata $.excepts) -}}
      {{- if include "rpa-browser.cidrContains" (dict "outer" $e "inner" $cidr) -}}
        {{- if has $e $metadata -}}
          {{- fail (printf "%s: %s is inside the metadata range %s, which the browser may never reach" $.what $cidr $e) -}}
        {{- end -}}
        {{- fail (printf "egress.exceptCIDRs: %s covers all of %s entry %s; remove one of them" $e $.what $cidr) -}}
      {{- else if include "rpa-browser.cidrContains" (dict "outer" $cidr "inner" $e) -}}
        {{- $except = append $except $e -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- $block := dict "cidr" $cidr -}}
  {{- if $except }}{{ $_ := set $block "except" $except }}{{ end -}}
  {{- $peers = append $peers (dict "ipBlock" $block) -}}
{{- end -}}
{{- toYaml $peers -}}
{{- end -}}

{{/* The web egress peers: egress.allowedCIDRs minus the metadata ranges and egress.exceptCIDRs. */}}
{{- define "rpa-browser.webIpBlocks" -}}
{{- include "rpa-browser.ipBlocks" (dict "root" . "cidrs" (.Values.egress.allowedCIDRs | default list) "excepts" (.Values.egress.exceptCIDRs | default list) "what" "egress.allowedCIDRs" "allowInside" (list)) -}}
{{- end -}}

{{/* Extra DNS peers on port 53 (egress.dns.ipBlocks), for example NodeLocal DNSCache at 169.254.20.10/32. */}}
{{- define "rpa-browser.dnsIpBlocks" -}}
{{- include "rpa-browser.ipBlocks" (dict "root" . "cidrs" (.Values.egress.dns.ipBlocks | default list) "excepts" (list) "what" "egress.dns.ipBlocks" "allowInside" (list "169.254.20.10/32")) -}}
{{- end -}}

{{/*
Every template includes this first, so the same message comes first whichever template Helm renders first: the token
secret, then the image, then the scaling settings, then the egress and NetworkPolicy inputs. Renders nothing.
*/}}
{{- define "rpa-browser.validate" -}}
{{- $_ := required "token.existingSecret is required: the name of an existing Secret in the release namespace that holds the gate token (kubectl create secret generic rpa-browser-token --from-literal=token=\"$(openssl rand -hex 32)\")" .Values.token.existingSecret -}}
{{- $_ = include "rpa-browser.image" . -}}
{{- $mode := include "rpa-browser.autoscalingMode" . -}}
{{- $a := .Values.autoscaling -}}
{{- if and (ne $mode "none") (gt (int $a.min) (int $a.max)) -}}
{{- fail (printf "autoscaling.min (%v) is above autoscaling.max (%v)" $a.min $a.max) -}}
{{- end -}}
{{- $pattern := include "rpa-browser.fqdnPattern" . -}}
{{- range .Values.egress.fqdns -}}
{{- if not (regexMatch $pattern (toString .)) -}}
{{- fail (printf "egress.fqdns: %q is not a lower-case domain name or a *.<domain> pattern (never *, *.* or *.<tld>)" (toString .)) -}}
{{- end -}}
{{- end -}}
{{- range .Values.egress.exceptCIDRs }}{{ $_ = include "rpa-browser.parseCidr" . }}{{ end -}}
{{- if .Values.networkPolicy.enabled -}}
{{- if empty .Values.n8n.podSelector -}}
{{- fail "n8n.podSelector is required while networkPolicy.enabled: the matchLabels of the n8n pods that open browser sessions (the workers in queue mode)" -}}
{{- end -}}
{{- if and (eq $mode "keda") (empty .Values.metrics.from) -}}
{{- fail "autoscaling.mode keda with networkPolicy.enabled needs metrics.from (your Prometheus pods): otherwise the NetworkPolicy blocks the scrape of port 9464 and KEDA sees no sessions" -}}
{{- end -}}
{{- $_ = include "rpa-browser.webIpBlocks" . -}}
{{- $_ = include "rpa-browser.dnsIpBlocks" . -}}
{{- end -}}
{{- end -}}
