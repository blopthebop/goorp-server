/**
 * Goorp Backend - Firebase Cloud Functions
 * Reconstructed from deployed source
 */

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

// Initialize Firebase Admin
initializeApp();

// Secrets
const STEAM_API_KEY = defineSecret("STEAM_API_KEY");
const STEAM_APP_ID = defineSecret("STEAM_APP_ID");

// Allowed users mapping (steamid -> display name override)
const allowedUsers = new Map<string, string>([
  ["76561198069216536", "spit"],
  ["76561198365559712", "xXSnickerLicker69Xx"],
]);

// ============================================================================
// STEAM PROFILE HELPER
// ============================================================================

interface SteamPlayer {
  steamid: string;
  personaname: string;
  profileurl?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
}

async function fetchSteamProfile(steamId: string): Promise<SteamPlayer | null> {
  try {
    const response = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY.value()}&steamids=${steamId}`
    );
    const data = await response.json();
    return data.response.players[0];
  } catch (error) {
    logger.error(
      `[goorp-backend] [fetchSteamProfile()] [error]: Failed to fetch profile: ${steamId}`,
      error
    );
    return null;
  }
}

// ============================================================================
// EXCHANGE STEAM TICKET
// ============================================================================

async function exchangeSteamTicketHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    if (request.method !== "POST") {
      response.status(405).send({ error: "Method not allowed" });
    }

    const ticket = request.body.ticket;
    if (!ticket) {
      response.status(400).send({ error: "Missing property ticket" });
    }

    const steamResponse = await fetch(
      `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${STEAM_API_KEY.value()}&appid=${STEAM_APP_ID.value()}&ticket=${ticket}`
    );
    const steamData = await steamResponse.json();

    if (!steamData.response.params.steamid) {
      response.status(400).send({ error: "Invalid ticket" });
    }

    const firebaseToken = await getAuth().createCustomToken(
      steamData.response.params.steamid
    );
    response.json({ firebase_token: firebaseToken });
  } catch (error) {
    logger.error(error);
    response.status(500).send({ error: "Internal server error" });
  }
}

// ============================================================================
// GET ITEMS
// ============================================================================

async function getItemsHandler(request: any, response: any): Promise<void> {
  const itemId = request.query.id;

  try {
    const db = getFirestore();

    if (itemId) {
      if (typeof itemId !== "string" || itemId.trim() === "") {
        response.status(400).json({ error: "Invalid item id" });
      }

      const docSnap = await db.collection("items").doc(itemId).get();
      if (!docSnap.exists) {
        response.status(404).json({ error: `Item not found for id: "${itemId}"` });
      }

      response
        .set("Cache-Control", "public, max-age=300")
        .json(docSnap.data());
    } else {
      const snapshot = await db.collection("items").get();
      if (snapshot.empty) {
        response.status(404).json({ error: "No documents found in the collection" });
      }

      const items = snapshot.docs.map((doc) => doc.data());
      response.set("Cache-Control", "public, max-age=300").json(items);
    }
  } catch (error) {
    logger.error("Error fetching items:", error);
    response.status(500).json({ error: "Failed to fetch items" });
  }
}

// ============================================================================
// SYNC PLAYER PROFILE
// ============================================================================

async function syncPlayerProfileHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    logger.debug("Authorization Header:", request.headers.authorization);

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [syncPlayerProfile] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
    }

    logger.debug("Authorization Header:", request.headers.authorization);
    const token = authHeader.split("Bearer ")[1];

    if (logger.debug("Bearer Token:", request.headers.authorization), !token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
    }

    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      logger.debug("Decoded Token:", decodedToken);

      const uid = decodedToken.uid;
      const steamProfile = await fetchSteamProfile(uid);
      const displayName =
        allowedUsers.get(steamProfile!.steamid) ||
        steamProfile!.personaname ||
        "Adventurer";

      const playerRef = getFirestore().collection("players").doc(uid);
      const playerDoc = await playerRef.get();

      if (!playerDoc.exists) {
        await playerRef.set({
          profile: {
            displayName: displayName,
            createdAt: FieldValue.serverTimestamp(),
            lastLogin: FieldValue.serverTimestamp(),
          },
          stats: {
            level: 1,
            experience: 0,
            kills: 0,
            deaths: 0,
            extractionsSuccessful: 0,
            extractionsFailed: 0,
            goldEarned: 0,
          }
        });

        // Create subcollections
        await playerRef.collection("stash");
        await playerRef.collection("expedition");
        await playerRef.collection("raids");
      } else {
        await playerRef.update({
          "profile.displayName": displayName,
          "profile.lastLogin": FieldValue.serverTimestamp(),
        });
      }
    } catch (error) {
      logger.error(
        "[goorp-backend] [syncPlayerProfile] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [syncPlayerProfile] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// ============================================================================
// UPDATE GOLD
// ============================================================================

async function updateGoldHandler(request: any, response: any): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [updateGold] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
      return;
    }

    const { amount } = request.body;
    if (typeof amount !== "number") {
      response
        .status(400)
        .json({ error: "Invalid request - amount must be a number" });
      return;
    }

    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const uid = decodedToken.uid;

      const playerRef = getFirestore().collection("players").doc(uid);
      const playerDoc = await playerRef.get();

      if (!playerDoc.exists) {
        response.status(404).json({ error: "Player not found" });
        return;
      }

      const currentGold = (playerDoc.data()?.stats?.goldEarned || 0) + amount;
      if (currentGold < 0) {
        response.status(400).json({ error: "Insufficient gold" });
        return;
      }

      await playerRef.update({
        "stats.goldEarned": FieldValue.increment(amount),
      });

      response.status(200).json({ success: true, gold: currentGold });
    } catch (error) {
      logger.error(
        "[goorp-backend] [updateGold] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [updateGold] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// ============================================================================
// END RAID (Callable)
// ============================================================================

interface EndRaidData {
  outcome: "extracted" | "killed" | "disconnected";
  durationSeconds: number;
  kills?: number;
  deaths?: number;
  goldEarned?: number;
}

async function endRaidHandler(request: any, context: any): Promise<any> {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Must be authenticated to end an raid"
    );
  }

  const { uid } = request.auth;
  const db = getFirestore();

  const {
    outcome,
    durationSeconds,
    kills = 0,
    deaths = 0,
    goldEarned = 0,
  } = request.data as EndRaidData;

  if (!["extracted", "killed", "disconnected"].includes(outcome)) {
    throw new HttpsError("invalid-argument", "Invalid raid outcome");
  }

  const raidData = {
    outcome,
    durationSeconds,
    kills,
    deaths,
    goldEarned,
    endedAt: FieldValue.serverTimestamp(),
  };

  const playerRef = db.collection("players").doc(uid);
  const raidRef = playerRef.collection("raids").doc();
  const batch = db.batch();

  batch.set(raidRef, raidData);
  batch.update(playerRef, {
    "stats.kills": FieldValue.increment(kills),
    "stats.deaths": FieldValue.increment(deaths),
    "stats.goldEarned": FieldValue.increment(goldEarned),
    "stats.extractionsSuccessful": FieldValue.increment(
      outcome === "extracted" ? 1 : 0
    ),
    "stats.extractionsFailed": FieldValue.increment(
      outcome !== "extracted" ? 1 : 0
    ),
    "profile.lastLogin": FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return { success: true, raidId: raidRef.id };
}

// ============================================================================
// UPLOAD PLAYER INVENTORY (Callable)
// ============================================================================

// Equipment slot mapping
const EQUIP_SLOT_MAP: Record<number, string> = {
  0: "none",
  1: "head",
  2: "chest",
  3: "legs",
  4: "feet",
  5: "main_hand",
  6: "off_hand",
  7: "belt",
  8: "back",
};

const VALID_SLOTS = [
  "head",
  "chest",
  "legs",
  "feet",
  "main_hand",
  "off_hand",
  "belt",
  "back",
];

// Grid constants
const STASH_WIDTH = 10;
const STASH_HEIGHT = 10;
const EXPEDITION_WIDTH = 4;
const EXPEDITION_HEIGHT = 4;
const MAX_STASH_ITEMS = 100;
const MAX_EXPEDITION_ITEMS = 16;
const MAX_CONTAINER_DEPTH = 2;
const SAVE_COOLDOWN_MS = 5000;

// Rate limiting
const lastSaveTime = new Map<string, number>();

// Item template cache
let itemTemplateCache: Map<string, any> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000;

interface InventoryItem {
  t: string; // template id
  n: number; // stack count
  x?: number;
  y?: number;
  r?: boolean; // rotated
  c?: number; // condition
  slot?: string;
  contents?: InventoryItem[];
}

async function uploadPlayerInvHandler(request: any): Promise<any> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const { uid } = request.auth;
  const db = getFirestore();
  const now = Date.now();

  // Rate limiting
  const lastSave = lastSaveTime.get(uid) || 0;
  if (now - lastSave < SAVE_COOLDOWN_MS) {
    throw new HttpsError("resource-exhausted", "Please wait before saving again");
  }
  lastSaveTime.set(uid, now);

  const { stash = [], expedition = [], equipment = [] } = request.data;

  // Load item templates
  const templates = await loadItemTemplates(db);

  // Validate stash
  const stashValidation = validateGridItems(
    stash,
    templates,
    STASH_WIDTH,
    STASH_HEIGHT,
    MAX_STASH_ITEMS,
    "stash"
  );
  if (!stashValidation.valid) {
    throw new HttpsError(
      "invalid-argument",
      `Stash validation failed: ${stashValidation.error}`
    );
  }

  // Validate expedition
  const expeditionValidation = validateGridItems(
    expedition,
    templates,
    EXPEDITION_WIDTH,
    EXPEDITION_HEIGHT,
    MAX_EXPEDITION_ITEMS,
    "expedition"
  );
  if (!expeditionValidation.valid) {
    throw new HttpsError(
      "invalid-argument",
      `Expedition validation failed: ${expeditionValidation.error}`
    );
  }

  // Validate equipment
  const equipmentValidation = validateEquipment(equipment, templates);
  if (!equipmentValidation.valid) {
    throw new HttpsError(
      "invalid-argument",
      `Equipment validation failed: ${equipmentValidation.error}`
    );
  }

  // Sanitize items
  const sanitizedStash = sanitizeItems(stash);
  const sanitizedExpedition = sanitizeItems(expedition);
  const sanitizedEquipment = sanitizeEquipmentItems(equipment);

  // Save to Firestore
  const playerRef = db.collection("players").doc(uid);
  const batch = db.batch();

  const stashRef = playerRef.collection("stash").doc("current");
  batch.set(stashRef, {
    items: sanitizedStash,
    lastUpdated: FieldValue.serverTimestamp(),
  });

  const expeditionRef = playerRef.collection("expedition").doc("current");
  batch.set(expeditionRef, {
    items: sanitizedExpedition,
    lastUpdated: FieldValue.serverTimestamp(),
  });

  const equipmentRef = playerRef.collection("equipment").doc("current");
  batch.set(equipmentRef, {
    items: sanitizedEquipment,
    lastUpdated: FieldValue.serverTimestamp(),
  });

  batch.set(
    playerRef,
    {
      lastUpdated: FieldValue.serverTimestamp(),
      updateCount: FieldValue.increment(1),
    },
    { merge: true }
  );

  await batch.commit();

  return {
    success: true,
    itemCounts: {
      stash: sanitizedStash.length,
      expedition: sanitizedExpedition.length,
      equipment: sanitizedEquipment.length,
    },
  };
}

async function loadItemTemplates(
  db: FirebaseFirestore.Firestore
): Promise<Map<string, any>> {
  const now = Date.now();
  if (itemTemplateCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return itemTemplateCache;
  }

  const snapshot = await db.collection("items").get();
  const templates = new Map<string, any>();

  snapshot.forEach((doc) => {
    templates.set(doc.id, doc.data());
  });

  console.log(`[uploadPlayerInv] Loaded ${templates.size} item templates`);
  itemTemplateCache = templates;
  cacheTimestamp = now;

  return templates;
}

function validateGridItems(
  items: InventoryItem[],
  templates: Map<string, any>,
  gridWidth: number,
  gridHeight: number,
  maxItems: number,
  gridName: string
): { valid: boolean; error?: string } {
  if (!Array.isArray(items)) {
    return { valid: false, error: "Items must be an array" };
  }

  if (items.length > maxItems) {
    return { valid: false, error: `Too many items (${items.length} > ${maxItems})` };
  }

  const occupiedCells = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const itemValidation = validateItem(item, templates, 0);
    if (!itemValidation.valid) {
      return { valid: false, error: `Item ${i}: ${itemValidation.error}` };
    }

    const template = templates.get(item.t);
    if (!template) {
      return { valid: false, error: `Item ${i}: Unknown template "${item.t}"` };
    }

    const width = item.r ? template.grid_height : template.grid_width;
    const height = item.r ? template.grid_width : template.grid_height;

    if (item.x === undefined || item.y === undefined) {
      return { valid: false, error: `Item ${i}: Missing position` };
    }

    if (item.x < 0 || item.y < 0) {
      return {
        valid: false,
        error: `Item ${i}: Negative position (${item.x}, ${item.y})`,
      };
    }

    if (item.x + width > gridWidth) {
      return {
        valid: false,
        error: `Item ${i} "${template.item_name}": Overflows grid width`,
      };
    }

    if (item.y + height > gridHeight) {
      return {
        valid: false,
        error: `Item ${i} "${template.item_name}": Overflows grid height`,
      };
    }

    // Check for overlaps
    for (let dx = 0; dx < width; dx++) {
      for (let dy = 0; dy < height; dy++) {
        const cellKey = `${item.x + dx},${item.y + dy}`;
        if (occupiedCells.has(cellKey)) {
          return {
            valid: false,
            error: `Item ${i} "${template.item_name}": Overlaps at (${item.x + dx}, ${item.y + dy})`,
          };
        }
        occupiedCells.add(cellKey);
      }
    }
  }

  return { valid: true };
}

function validateItem(
  item: InventoryItem,
  templates: Map<string, any>,
  depth: number
): { valid: boolean; error?: string } {
  if (depth > MAX_CONTAINER_DEPTH) {
    return { valid: false, error: "Container nesting too deep" };
  }

  if (!item.t || typeof item.t !== "string") {
    return { valid: false, error: "Missing template ID" };
  }

  if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(item.t)) {
    return { valid: false, error: `Invalid template ID format: "${item.t}"` };
  }

  const template = templates.get(item.t);
  if (!template) {
    return { valid: false, error: `Unknown item: "${item.t}"` };
  }

  if (typeof item.n !== "number" || !Number.isInteger(item.n) || item.n < 1) {
    return { valid: false, error: "Invalid stack size" };
  }

  if (item.n > template.max_stack) {
    return {
      valid: false,
      error: `Stack ${item.n} exceeds max ${template.max_stack}`,
    };
  }

  if (!template.is_stackable && item.n > 1) {
    return { valid: false, error: `"${template.item_name}" is not stackable` };
  }

  if (item.r !== undefined && typeof item.r !== "boolean") {
    return { valid: false, error: "Invalid rotation value" };
  }

  if (item.c !== undefined) {
    if (typeof item.c !== "number" || item.c < 0 || item.c > 100) {
      return { valid: false, error: "Condition must be 0-100" };
    }
  }

  // Validate container contents
  if (item.contents) {
    if (!template.is_container) {
      return { valid: false, error: `"${template.item_name}" is not a container` };
    }

    if (!Array.isArray(item.contents)) {
      return { valid: false, error: "Contents must be an array" };
    }

    const { container_grid_width, container_grid_height } = template;
    const containerCells = new Set<string>();

    for (let i = 0; i < item.contents.length; i++) {
      const contentItem = item.contents[i];

      const contentValidation = validateItem(contentItem, templates, depth + 1);
      if (!contentValidation.valid) {
        return { valid: false, error: `Contents[${i}]: ${contentValidation.error}` };
      }

      const contentTemplate = templates.get(contentItem.t);
      if (!contentTemplate) {
        return { valid: false, error: `Contents[${i}]: Unknown item` };
      }

      if (contentItem.x === undefined || contentItem.y === undefined) {
        return { valid: false, error: `Contents[${i}]: Missing position` };
      }

      const cWidth = contentItem.r
        ? contentTemplate.grid_height
        : contentTemplate.grid_width;
      const cHeight = contentItem.r
        ? contentTemplate.grid_width
        : contentTemplate.grid_height;

      if (
        contentItem.x < 0 ||
        contentItem.y < 0 ||
        contentItem.x + cWidth > container_grid_width ||
        contentItem.y + cHeight > container_grid_height
      ) {
        return { valid: false, error: `Contents[${i}]: Outside container bounds` };
      }

      for (let dx = 0; dx < cWidth; dx++) {
        for (let dy = 0; dy < cHeight; dy++) {
          const cellKey = `${contentItem.x + dx},${contentItem.y + dy}`;
          if (containerCells.has(cellKey)) {
            return {
              valid: false,
              error: `Contents[${i}]: Overlaps within container`,
            };
          }
          containerCells.add(cellKey);
        }
      }
    }
  }

  return { valid: true };
}

function validateEquipment(
  equipment: InventoryItem[],
  templates: Map<string, any>
): { valid: boolean; error?: string } {
  if (!Array.isArray(equipment)) {
    return { valid: false, error: "Equipment must be an array" };
  }

  const usedSlots = new Set<string>();

  for (let i = 0; i < equipment.length; i++) {
    const item = equipment[i];

    if (!item.slot || typeof item.slot !== "string") {
      return { valid: false, error: `Equipment[${i}]: Missing slot` };
    }

    if (!VALID_SLOTS.includes(item.slot)) {
      return { valid: false, error: `Equipment[${i}]: Invalid slot "${item.slot}"` };
    }

    if (usedSlots.has(item.slot)) {
      return {
        valid: false,
        error: `Equipment[${i}]: Duplicate slot "${item.slot}"`,
      };
    }
    usedSlots.add(item.slot);

    const equipItemValidation = validateEquipmentItem(item, templates);
    if (!equipItemValidation.valid) {
      return {
        valid: false,
        error: `Equipment[${i}] (${item.slot}): ${equipItemValidation.error}`,
      };
    }

    const template = templates.get(item.t);
    if (!template) {
      return {
        valid: false,
        error: `Equipment[${i}]: Unknown item "${item.t}"`,
      };
    }

    const expectedSlot = EQUIP_SLOT_MAP[template.equip_slot];
    if (expectedSlot === "none") {
      return { valid: false, error: `"${template.item_name}" cannot be equipped` };
    }

    if (expectedSlot !== item.slot) {
      return {
        valid: false,
        error: `"${template.item_name}" goes in ${expectedSlot}, not ${item.slot}`,
      };
    }
  }

  return { valid: true };
}

function validateEquipmentItem(
  item: InventoryItem,
  templates: Map<string, any>
): { valid: boolean; error?: string } {
  if (!item.t || typeof item.t !== "string") {
    return { valid: false, error: "Missing template ID" };
  }

  if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(item.t)) {
    return { valid: false, error: `Invalid template ID format: "${item.t}"` };
  }

  const template = templates.get(item.t);
  if (!template) {
    return { valid: false, error: `Unknown item: "${item.t}"` };
  }

  if (typeof item.n !== "number" || !Number.isInteger(item.n) || item.n < 1) {
    return { valid: false, error: "Invalid stack size" };
  }

  if (item.n > template.max_stack) {
    return {
      valid: false,
      error: `Stack ${item.n} exceeds max ${template.max_stack}`,
    };
  }

  if (!template.is_stackable && item.n > 1) {
    return { valid: false, error: `"${template.item_name}" is not stackable` };
  }

  if (item.r !== undefined && typeof item.r !== "boolean") {
    return { valid: false, error: "Invalid rotation value" };
  }

  if (item.c !== undefined) {
    if (typeof item.c !== "number" || item.c < 0 || item.c > 100) {
      return { valid: false, error: "Condition must be 0-100" };
    }
  }

  // Validate container contents for equipment
  if (item.contents) {
    if (!template.is_container) {
      return { valid: false, error: `"${template.item_name}" is not a container` };
    }

    if (!Array.isArray(item.contents)) {
      return { valid: false, error: "Contents must be an array" };
    }

    const { container_grid_width, container_grid_height } = template;
    const containerCells = new Set<string>();

    for (let i = 0; i < item.contents.length; i++) {
      const contentItem = item.contents[i];

      const contentValidation = validateItem(contentItem, templates, 1);
      if (!contentValidation.valid) {
        return { valid: false, error: `Contents[${i}]: ${contentValidation.error}` };
      }

      const contentTemplate = templates.get(contentItem.t);
      if (!contentTemplate) {
        return { valid: false, error: `Contents[${i}]: Unknown item` };
      }

      if (contentItem.x === undefined || contentItem.y === undefined) {
        return { valid: false, error: `Contents[${i}]: Missing position` };
      }

      const cWidth = contentItem.r
        ? contentTemplate.grid_height
        : contentTemplate.grid_width;
      const cHeight = contentItem.r
        ? contentTemplate.grid_width
        : contentTemplate.grid_height;

      if (
        contentItem.x < 0 ||
        contentItem.y < 0 ||
        contentItem.x + cWidth > container_grid_width ||
        contentItem.y + cHeight > container_grid_height
      ) {
        return { valid: false, error: `Contents[${i}]: Outside container bounds` };
      }

      for (let dx = 0; dx < cWidth; dx++) {
        for (let dy = 0; dy < cHeight; dy++) {
          const cellKey = `${contentItem.x + dx},${contentItem.y + dy}`;
          if (containerCells.has(cellKey)) {
            return {
              valid: false,
              error: `Contents[${i}]: Overlaps within container`,
            };
          }
          containerCells.add(cellKey);
        }
      }
    }
  }

  return { valid: true };
}

function sanitizeItem(item: InventoryItem): InventoryItem {
  const sanitized: InventoryItem = {
    t: item.t,
    n: Math.floor(item.n),
  };

  if (item.x !== undefined) sanitized.x = Math.floor(item.x);
  if (item.y !== undefined) sanitized.y = Math.floor(item.y);
  if (item.slot) sanitized.slot = item.slot;
  if (item.r === true) sanitized.r = true;
  if (item.c !== undefined && item.c < 100)
    sanitized.c = Math.round(item.c * 10) / 10;
  if (item.contents && item.contents.length > 0) {
    sanitized.contents = item.contents.map((c) => sanitizeItem(c));
  }

  return sanitized;
}

function sanitizeItems(items: InventoryItem[]): InventoryItem[] {
  return items.map((item) => sanitizeItem(item));
}

function sanitizeEquipmentItems(items: InventoryItem[]): InventoryItem[] {
  return items.map((item) => sanitizeItem(item));
}

// ============================================================================
// GET SHOP ITEMS
// ============================================================================

const SHOP_ITEM_PATHS = [
  "res://resources/items/ancient_artifact.tres",
  "res://resources/items/ancient_map.tres",
  "res://resources/items/antidote.tres",
  "res://resources/items/apple.tres",
  "res://resources/items/bandage.tres",
  "res://resources/items/battle_axe.tres",
  "res://resources/items/bread.tres",
  "res://resources/items/chainmail_chest.tres",
  "res://resources/items/cloth_hood.tres",
  "res://resources/items/cloth_scrap.tres",
  "res://resources/items/cooked_meat.tres",
  "res://resources/items/dagger.tres",
  "res://resources/items/diamond.tres",
  "res://resources/items/dragonbone_sword.tres",
  "res://resources/items/dragon_scale_armor.tres",
  "res://resources/items/dungeon_key.tres",
  "res://resources/items/elixir_of_life.tres",
  "res://resources/items/emerald.tres",
  "res://resources/items/enchanted_blade.tres",
  "res://resources/items/gold_coins.tres",
  "res://resources/items/gold_ring.tres",
  "res://resources/items/greater_health_potion.tres",
  "res://resources/items/health_potion.tres",
  "res://resources/items/iron_boots.tres",
  "res://resources/items/iron_chestplate.tres",
  "res://resources/items/iron_greaves.tres",
  "res://resources/items/iron_helmet.tres",
  "res://resources/items/iron_ingot.tres",
  "res://resources/items/iron_mace.tres",
  "res://resources/items/large_backpack.tres",
  "res://resources/items/leather_armor.tres",
  "res://resources/items/leather_backpack.tres",
  "res://resources/items/leather_belt.tres",
  "res://resources/items/leather_boots.tres",
  "res://resources/items/leather_chaps.tres",
  "res://resources/items/leather_strip.tres",
  "res://resources/items/longbow.tres",
  "res://resources/items/mana_potion.tres",
  "res://resources/items/ruby.tres",
  "res://resources/items/rusty_key.tres",
  "res://resources/items/sapphire.tres",
  "res://resources/items/shadow_cloak.tres",
  "res://resources/items/silver_ring.tres",
  "res://resources/items/skull.tres",
  "res://resources/items/small_pouch.tres",
  "res://resources/items/stamina_potion.tres",
  "res://resources/items/steel_helmet.tres",
  "res://resources/items/steel_ingot.tres",
  "res://resources/items/steel_sword.tres",
  "res://resources/items/sword_basic.tres",
  "res://resources/items/wooden_shield.tres",
  "res://resources/items/wooden_torch.tres",
];

async function getShopItemsHandler(
  request: any,
  response: any
): Promise<void> {
  const shopItems: Array<{ path: string; stock: number; price_mod: number }> = [];
  const itemCount = Math.floor(Math.random() * 5) + 1;

  for (let i = 0; i < itemCount; i++) {
    shopItems.push({
      path: SHOP_ITEM_PATHS[Math.floor(Math.random() * SHOP_ITEM_PATHS.length)],
      stock: Math.floor(Math.random() * 5) + 1,
      price_mod: Math.random() * 0.4 + 0.8, // 0.8 to 1.2
    });
  }

  response.json(shopItems);
}

// ============================================================================
// TRADING LISTINGS
// ============================================================================

// Cancel Trading Listing
async function cancelTradingListingHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [cancelTradingListing] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
      return;
    }

    const { listing_id } = request.body;
    if (typeof listing_id !== "string" || !listing_id) {
      response.status(400).json({
        error: "Invalid request - listing_id must be a non-empty string",
      });
      return;
    }

    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const uid = decodedToken.uid;

      const listingRef = getFirestore()
        .collection("trading_listings")
        .doc(listing_id);
      const listingDoc = await listingRef.get();

      if (!listingDoc.exists) {
        response.status(404).json({ error: "Listing not found" });
        return;
      }

      const listingData = listingDoc.data();
      if (!listingData) {
        response.status(404).json({ error: "Listing data not found" });
        return;
      }

      if (listingData.seller_id !== uid) {
        response
          .status(403)
          .json({ error: "You can only cancel your own listings" });
        return;
      }

      if (listingData.status !== "active") {
        response.status(400).json({ error: "Listing is no longer active" });
        return;
      }

      await listingRef.update({
        status: "cancelled",
        cancelled_at: Date.now(),
      });

      logger.info(
        `[goorp-backend] [cancelTradingListing] Listing ${listing_id} cancelled by ${uid}`
      );

      response.status(200).json({
        success: true,
        item_template_id: listingData.item_template_id,
        stack_size: listingData.stack_size,
      });
    } catch (error) {
      logger.error(
        "[goorp-backend] [cancelTradingListing] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [cancelTradingListing] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// Get Trading Listings
async function getTradingListingsHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [getTradingListings] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
      return;
    }

    try {
      await getAuth().verifyIdToken(token);

      const snapshot = await getFirestore()
        .collection("trading_listings")
        .where("status", "==", "active")
        .orderBy("posted_at", "desc")
        .limit(100)
        .get();

      const listings: any[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        listings.push({
          listing_id: doc.id,
          seller_id: data.seller_id,
          seller_steam_id: data.seller_steam_id,
          seller_name: data.seller_name,
          item_template_id: data.item_template_id,
          stack_size: data.stack_size,
          price: data.price,
          posted_at: data.posted_at,
        });
      });

      logger.info(
        `[goorp-backend] [getTradingListings] Returned ${listings.length} listings`
      );

      response.status(200).json({ success: true, listings });
    } catch (error) {
      logger.error(
        "[goorp-backend] [getTradingListings] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [getTradingListings] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// Purchase Trading Listing
async function purchaseTradingListingHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [purchaseTradingListing] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
      return;
    }

    const { listing_id } = request.body;
    if (typeof listing_id !== "string" || !listing_id) {
      response.status(400).json({
        error: "Invalid request - listing_id must be a non-empty string",
      });
      return;
    }

    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const buyerId = decodedToken.uid;
      const db = getFirestore();

      const listingRef = db.collection("trading_listings").doc(listing_id);
      const listingDoc = await listingRef.get();

      if (!listingDoc.exists) {
        response.status(404).json({ error: "Listing not found" });
        return;
      }

      const listingData = listingDoc.data();
      if (!listingData) {
        response.status(404).json({ error: "Listing data not found" });
        return;
      }

      if (listingData.status !== "active") {
        response.status(400).json({ error: "Listing is no longer available" });
        return;
      }

      if (listingData.seller_id === buyerId) {
        response.status(400).json({ error: "Cannot purchase your own listing" });
        return;
      }

      const buyerRef = db.collection("players").doc(buyerId);
      const buyerDoc = await buyerRef.get();

      if (!buyerDoc.exists) {
        response.status(404).json({ error: "Buyer player not found" });
        return;
      }

      const buyerData = buyerDoc.data();
      if (!buyerData) {
        response.status(404).json({ error: "Buyer data not found" });
        return;
      }

      const buyerGold = buyerData.stats.goldEarned || 0;
      const price = listingData.price;

      if (buyerGold < price) {
        response.status(400).json({ error: "Insufficient gold" });
        return;
      }

      const sellerId = listingData.seller_id;
      const sellerRef = db.collection("players").doc(sellerId);
      const sellerDoc = await sellerRef.get();

      const batch = db.batch();
      const newBuyerGold = buyerGold - price;

      // Deduct from buyer
      batch.update(buyerRef, {
        "stats.goldEarned": FieldValue.increment(-price),
      });

      // Add to seller if exists
      if (sellerDoc.exists) {
        batch.update(sellerRef, {
          "stats.goldEarned": FieldValue.increment(price),
        });
      }

      // Update listing status
      batch.update(listingRef, {
        status: "sold",
        buyer_id: buyerId,
        sold_at: Date.now(),
      });

      await batch.commit();

      logger.info(
        `[goorp-backend] [purchaseTradingListing] Listing ${listing_id} purchased by ${buyerId} for ${price} gold`
      );

      response.status(200).json({
        success: true,
        gold: newBuyerGold,
        item_template_id: listingData.item_template_id,
        stack_size: listingData.stack_size,
      });
    } catch (error) {
      logger.error(
        "[goorp-backend] [purchaseTradingListing] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [purchaseTradingListing] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// Post Trading Listing
async function postTradingListingHandler(
  request: any,
  response: any
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.error(
        '[goorp-backend] [postTradingListing] [error] Invalid "authorization" header'
      );
      response
        .status(401)
        .json({ error: "Unauthorized - provide a bearer token" });
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      response.status(401).json({ error: "Unauthorized - invalid bearer token" });
      return;
    }

    const { item_template_id, stack_size, price } = request.body;

    if (typeof item_template_id !== "string" || !item_template_id) {
      response.status(400).json({
        error: "Invalid request - item_template_id must be a non-empty string",
      });
      return;
    }

    if (typeof stack_size !== "number" || stack_size < 1) {
      response.status(400).json({
        error: "Invalid request - stack_size must be a positive number",
      });
      return;
    }

    if (typeof price !== "number" || price < 1) {
      response.status(400).json({
        error: "Invalid request - price must be a positive number",
      });
      return;
    }

    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      const uid = decodedToken.uid;
      const db = getFirestore();

      const playerDoc = await db.collection("players").doc(uid).get();
      if (!playerDoc.exists) {
        response.status(404).json({ error: "Player not found" });
        return;
      }

      const playerData = playerDoc.data();

      // Try to get Steam profile name
      let sellerName = "Unknown";
      try {
        const steamProfile = await fetchSteamProfile(uid);
        if (steamProfile) {
          sellerName = steamProfile.personaname;
        }
      } catch (err) {
        logger.warn(
          "[goorp-backend] [postTradingListing] Could not fetch Steam profile:",
          err
        );
      }

      const listingRef = db.collection("trading_listings").doc();
      const listingData = {
        listing_id: listingRef.id,
        seller_id: uid,
        seller_steam_id: uid,
        seller_name: sellerName,
        item_template_id,
        stack_size,
        price,
        posted_at: Date.now(),
        status: "active",
      };

      await listingRef.set(listingData);

      logger.info(
        `[goorp-backend] [postTradingListing] Listing created: ${listingRef.id} by ${uid}`
      );

      response.status(200).json({ success: true, listing_id: listingRef.id });
    } catch (error) {
      logger.error(
        "[goorp-backend] [postTradingListing] Token verification failed:",
        error
      );
      response.status(401).json({
        error: "Invalid token: " + (error instanceof Error ? error.message : ""),
      });
    }
  } catch (error) {
    logger.error("[goorp-backend] [postTradingListing] [error]", error);
    response
      .status(500)
      .json({ error: error instanceof Error ? error.message : "" });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  exchangeSteamTicket: onRequest({ secrets: [STEAM_API_KEY] }, exchangeSteamTicketHandler),
  syncPlayerProfile: onRequest({ secrets: [STEAM_API_KEY] }, syncPlayerProfileHandler),
  updateGold: onRequest({ secrets: [STEAM_API_KEY] }, updateGoldHandler),
  endRaid: onCall(endRaidHandler),
  uploadPlayerInv: onCall(uploadPlayerInvHandler),
  getItems: onRequest(getItemsHandler),
  getShopItems: onRequest(getShopItemsHandler),
  postTradingListing: onRequest({ secrets: [STEAM_API_KEY] }, postTradingListingHandler),
  purchaseTradingListing: onRequest({ secrets: [STEAM_API_KEY] }, purchaseTradingListingHandler),
  cancelTradingListing: onRequest({ secrets: [STEAM_API_KEY] }, cancelTradingListingHandler),
  getTradingListings: onRequest(getTradingListingsHandler),
};
