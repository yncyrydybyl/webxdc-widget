/*
 * The Matrix side of webxdc. Namespaced until there is an MSC.
 *
 * instance  room state, state key = instance id: one shared app (the .xdc in the
 *           media repo plus its name and icon). Cleartext, like all room state.
 * update    timeline event: one or more webxdc updates of one instance. Encrypted
 *           in E2EE rooms.
 * sync      timeline event: a newcomer asks for the update log, an open peer
 *           answers with it. Encrypted in E2EE rooms.
 * realtime  to-device: joinRealtimeChannel() data, ephemeral.
 */
export const NS = "de.datanauten.webxdc";
export const INSTANCE_TYPE = `${NS}.instance`;
export const UPDATE_TYPE = `${NS}.update`;
export const SYNC_TYPE = `${NS}.sync`;
export const REALTIME_TYPE = `${NS}.realtime`;
export const WIDGET_TYPE = "im.vector.modular.widgets";
export const WIDGET_KIND = `${NS}.player`;

/** Matrix `EncryptedFile` (client-server spec, attachments). */
export interface EncryptedFile {
    url: string;
    key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
    iv: string;
    hashes: { sha256: string };
    v: "v2";
}

export interface InstanceContent {
    v: 1;
    name: string;
    /** The .xdc in the media repo, unencrypted: a key next to it in cleartext state would protect nothing. */
    mxc: string;
    /** Hex SHA-256 of the .xdc, checked after download. */
    sha256: string;
    size: number;
    icon?: string;
    description?: string;
    source_code_url?: string;
    /** Where it came from, when it came from a catalog. */
    origin?: { catalog: string; app_id: string; tag_name?: string };
}

/** What an app passes to sendUpdate(), after a JSON round trip. */
export interface WebxdcUpdate {
    payload: unknown;
    info?: string;
    href?: string;
    document?: string;
    summary?: string;
    notify?: Record<string, string>;
}

/** One update inside an update event; `id` is the sender's random id, for de-duplication. */
export interface WireUpdate extends WebxdcUpdate {
    id: string;
}

export interface UpdateContent {
    v: 1;
    instance: string;
    /** Inline, or */
    updates?: WireUpdate[];
    /** in an encrypted upload when large: JSON `WireUpdate[]`. */
    file?: EncryptedFile;
}

/** A log entry as peers exchange it: the update plus who sent it, when. */
export interface SyncEntry {
    id: string;
    sender: string;
    ts: number;
    update: WebxdcUpdate;
}

export interface SyncRequestContent {
    v: 1;
    instance: string;
    kind: "request";
    nonce: string;
    /** How many updates the requester has. */
    have: number;
}

export interface SyncOfferContent {
    v: 1;
    instance: string;
    kind: "offer";
    nonce: string;
    count: number;
    /** Inline, or */
    entries?: SyncEntry[];
    /** in an encrypted upload: JSON `SyncEntry[]`. */
    file?: EncryptedFile;
}

/**
 * A page's key for its realtime data, in the encrypted timeline: to-device
 * messages to "*" (all of a user's devices) cannot be encrypted by the client,
 * so the widget encrypts the payload itself. `nonce` is the sending page's peer id.
 */
export interface SyncKeyContent {
    v: 1;
    instance: string;
    kind: "rt-key";
    nonce: string;
    /** base64 raw AES-GCM-256 key */
    key: string;
}

export type SyncContent = SyncRequestContent | SyncOfferContent | SyncKeyContent;

/**
 * Realtime data as a to-device message: plain `data` in unencrypted rooms, `iv` +
 * `ct` (AES-GCM, our key) in encrypted ones. With `batch: 1` the payload holds
 * several messages, each a 4-byte big-endian length and its bytes: hosts send
 * to-device messages one at a time, so whatever an app sends meanwhile goes in the next one.
 */
export interface RealtimeContent {
    instance: string;
    peer: string;
    batch?: 1;
    /** One part of a message too big for one to-device event (apps may send 128 kB): `i` of `n`, all with the same `id`. */
    part?: { id: string; i: number; n: number };
    /** base64 */
    data?: string;
    iv?: string;
    ct?: string;
}

export const LOCAL_PREFIX = "local-";
