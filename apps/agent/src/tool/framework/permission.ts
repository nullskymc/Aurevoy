import { Context, Effect, Layer } from "effect"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny"
}

export class PermissionDeniedError extends Error {
  readonly _tag = "PermissionDeniedError"
  readonly action: string
  readonly resource: string
  constructor(action: string, resource: string) {
    super(`Permission denied: ${action} on ${resource}`)
    this.action = action
    this.resource = resource
  }
}

export interface PermissionService {
  readonly assert: (action: string, resource: string) => Effect.Effect<void, PermissionDeniedError>
  readonly allowAll: () => boolean
}

export class Permission extends Context.Tag("Permission")<
  Permission,
  PermissionService
>() {}

export const layer = (rules?: ReadonlyArray<PermissionRule>) =>
  Layer.succeed(
    Permission,
    Permission.of({
      allowAll: () => !rules || rules.length === 0,
      assert: (action: string, resource: string): Effect.Effect<void, PermissionDeniedError> => {
        if (!rules || rules.length === 0) return Effect.void
        for (let i = rules.length - 1; i >= 0; i--) {
          const r = rules[i]
          if (matchRule(r.action, action) && matchRule(r.resource, resource)) {
            if (r.effect === "deny") {
              return Effect.fail(new PermissionDeniedError(action, resource))
            }
            return Effect.void
          }
        }
        return Effect.void
      },
    }),
  )

function matchRule(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  return pattern === value
}
