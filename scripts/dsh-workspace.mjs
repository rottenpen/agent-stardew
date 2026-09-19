export const name = 'stardew-workspace'
export const inject = ['workspaceRegistry']

export async function apply(ctx, config) {
  await ctx.workspaceRegistry.create(config.path, '星露谷')
}
