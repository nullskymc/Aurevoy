/** provider:model — model 段可含冒号；provider 为合法 id */
export function modelNamespace(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function parseModelNamespace(value: string): { provider?: string; model: string } {
  const raw = value.trim();
  if (!raw) return { model: "" };
  const [maybeProvider, rest] = raw.split(/:(.*)/s);
  if (rest !== undefined && rest.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(maybeProvider)) {
    return { provider: maybeProvider, model: rest };
  }
  return { model: raw };
}
