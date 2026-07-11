import { z } from "zod";

/**
 * Canonical entity ID across the whole product: tarkov.dev's 24-hex id
 * (matches BSG Mongo-style ids). Never key on names or legacy tarkovDataId.
 */
export const TarkovId = z.string().regex(/^[0-9a-f]{24}$/);
export type TarkovId = z.infer<typeof TarkovId>;

export const GameMode = z.enum(["regular", "pve"]);
export type GameMode = z.infer<typeof GameMode>;
