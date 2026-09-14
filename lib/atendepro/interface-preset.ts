import type { InterfaceSettings } from "@/lib/navigation/interface";

/**
 * Preset inicial do AtendePro. A escolha fica no vínculo do usuário, não na
 * organização: duas pessoas da mesma empresa podem usar interfaces diferentes.
 * Os destinos são ids do NAV_CATALOG e não criam uma segunda lista de rotas.
 */
export const ATENDEPRO_DEFAULT_INTERFACE: InterfaceSettings = {
  preset: "simplificada",
  destinos: [
    "/app/inbox",
    "/app/agenda",
    "/app/kanban",
    "/app/contacts",
    "/app/tasks",
    "/app/connections",
    "/app/ai/agents",
    "/app/products",
    "/app/settings/tenant/agenda",
  ],
};
