// @webcode/support-ui ships plain ESM JavaScript without type declarations.
declare module '@webcode/support-ui' {
  export function hostCredentials(options: { app: string; request: () => Promise<unknown> }): unknown;
  export function createSupportClient(options: Record<string, unknown>): unknown;
  export function createSupportSession(options: Record<string, unknown>): unknown;
}
declare module '@webcode/support-ui/widget' {
  export function createSupportWidget(options: Record<string, unknown>): unknown;
}
