export interface TokenExemptUser {
  role?: { name?: string } | string | null;
}

/**
 * Business rule: admin users are not charged business tokens and are not
 * subject to business-token quota limits. Guardrails/content policy still apply.
 *
 * Accepts either a DB-shaped user (`{ role: { name } }`) or a JWT-shaped
 * principal (`{ role: "admin" }`) as produced by the authenticate middleware.
 */
export function isTokenExemptUser(user: TokenExemptUser | null | undefined): boolean {
  if (!user?.role) return false;
  if (typeof user.role === 'string') return user.role === 'admin';
  return user.role.name === 'admin';
}
