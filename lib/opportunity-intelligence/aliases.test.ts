import { describe, expect, it } from "vitest";

import {
  normalizeBusinessName,
  normalizeDomain,
  normalizePhone,
  resolveIdentityCluster,
} from "@/lib/opportunity-intelligence/aliases";

describe("Identity Aliases Resolution", () => {
  it("normaliza nomes societários removendo sufixos e pontuação", () => {
    expect(normalizeBusinessName("Padaria Central LTDA")).toBe("padariacentral");
    expect(normalizeBusinessName("Padaria Central S.A.")).toBe("padariacentral");
    expect(normalizeBusinessName("Padaria Central - ME")).toBe("padariacentral");
    expect(normalizeBusinessName("Padaria Central EIRELI")).toBe("padariacentral");
  });

  it("normaliza domínios removendo protocolos, www e query params", () => {
    expect(normalizeDomain("https://www.padariacentral.com.br/")).toBe("padariacentral.com.br");
    expect(normalizeDomain("http://padariacentral.com.br?utm=1")).toBe("padariacentral.com.br");
    expect(normalizeDomain("padariacentral.com.br")).toBe("padariacentral.com.br");
    expect(normalizeDomain("")).toBeNull();
  });

  it("normaliza telefones com código do país", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("+5511999998888");
    expect(normalizePhone("+5511999998888")).toBe("+5511999998888");
    expect(normalizePhone("123")).toBeNull();
  });

  it("prioriza registry_id como chave canônica sobre domain e telefone", () => {
    const cluster = resolveIdentityCluster([
      { display_name: "Padaria Central", domain: "padariacentral.com.br" },
      { display_name: "Padaria Central LTDA", registry_id: "12.345.678/0001-90" },
    ]);

    expect(cluster.canonical_key).toBe("registry:12.345.678/0001-90");
    expect(cluster.matched_by).toBe("registry_id");
    expect(cluster.confidence).toBe(1.0);
    expect(cluster.primary_identity.domain).toBe("padariacentral.com.br");
  });

  it("utiliza domain como chave canônica na ausência de registry_id", () => {
    const cluster = resolveIdentityCluster([
      { display_name: "Padaria Central - Matriz", domain: "https://padariacentral.com.br" },
      { display_name: "Padaria Central", phone_e164: "+5511999998888" },
    ]);

    expect(cluster.canonical_key).toBe("domain:padariacentral.com.br");
    expect(cluster.matched_by).toBe("domain");
    expect(cluster.confidence).toBe(0.95);
    expect(cluster.primary_identity.phone_e164).toBe("+5511999998888");
  });
});
