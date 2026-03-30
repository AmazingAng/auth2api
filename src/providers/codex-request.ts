function normalizeRole(role: unknown): unknown {
  if (role === "system") {
    return "developer";
  }
  return role;
}

function normalizeInputItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  return {
    ...item,
    role: normalizeRole((item as { role?: unknown }).role),
  };
}

export function normalizeCodexRequestBody(body: any): any {
  const normalized = body && typeof body === "object" ? { ...body } : {};

  if (typeof normalized.instructions !== "string") {
    normalized.instructions = "";
  }

  normalized.store = false;

  if (Array.isArray(normalized.input)) {
    normalized.input = normalized.input.map((item: unknown) => normalizeInputItem(item));
  }

  return normalized;
}
