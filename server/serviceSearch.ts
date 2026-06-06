import Fuse from "fuse.js";
import catalog from "./services_catalog.json";

type ServiceEntry = {
  name: string;
  aliases: string[];
  domain: string;
  cancelUrl: string;
};

const services: ServiceEntry[] = catalog as ServiceEntry[];

const fuse = new Fuse(services, {
  keys: ["name", "aliases", "domain"],
  threshold: 0.35,
  includeScore: true,
  shouldSort: true,
});

export function searchServices(query: string, limit = 10): ServiceEntry[] {
  const normalized = query.toLowerCase().replace(/[^\w\s.]/g, "").trim();
  if (!normalized) return [];
  const results = fuse.search(normalized, { limit });
  return results.map((r) => r.item);
}
