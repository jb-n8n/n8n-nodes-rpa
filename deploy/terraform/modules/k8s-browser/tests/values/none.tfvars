# The kind end-to-end shape: a fixed pod count, no NetworkPolicy, a digest-only image.
namespace              = "rpa"
token_secret_name      = "rpa-browser-token"
image                  = { repository = "ghcr.io/example/rpa-browser", digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
sessions_per_replica   = 1
drain_seconds          = 60
autoscaling            = { mode = "none", min = 2 }
network_policy_enabled = false
