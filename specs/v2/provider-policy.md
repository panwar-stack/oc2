# V2 Provider Policy

Provider policy is an implemented Location-scoped authorization layer. It decides whether a known provider may be used after provider and model sources have populated the Catalog.

## Statements

Authored V2 configuration accepts ordered statements under `experimental.policies`:

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "anthropic" },
    ],
  },
}
```

The current supported action is `provider.use`. Effects are `allow` and `deny`. Action and resource patterns use the shared wildcard matcher.

## Evaluation

Evaluation starts from the fallback supplied by the caller. Matching statements are considered in order and the last match wins. Pattern specificity has no implicit precedence.

Catalog provider use supplies `allow` as its fallback, so an empty policy preserves normal availability.

## Config Precedence

Ordinary configuration is applied from lower to higher priority. Policy documents are intentionally loaded in the opposite order so a user-global statement can override repository-authored policy. Statement order inside each document is preserved.

This gives the effective order:

```text
repository policy -> more global user policy
```

Configuration is read when a Location opens. Policy changes take effect when that Location is rebuilt; there is no live policy watcher contract.

## Catalog Enforcement

Catalog sources first contribute providers and models through replayable transforms. Catalog finalization then evaluates `provider.use` for each provider and removes denied providers before reads are exposed. Models owned by a denied provider disappear with that provider.

Policy is separate from provider configuration:

- provider configuration describes endpoints, request options, models, and defaults;
- policy decides whether the resulting provider may be selected or used;
- a denied provider remains denied regardless of whether it came from models.dev, credentials, built-ins, or authored configuration.

Plugins may contribute Catalog data, but they do not receive authority to rewrite policy statements.
