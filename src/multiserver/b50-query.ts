// /b50 family: which server a query targets, and the option snapshot a server pick resumes with.
// Order: manual choice > saved /server default > the single server with data. null means the player must choose.
import type { ChatInputCommandInteraction } from "discord.js"
import { dfBindings } from "../df/bindings.js"
import { lxnsBindings } from "../lxns/bindings.js"
import { scoreDatabase } from "../local/database.js"
import { isEnabledServer, resolveB50Server, type RemoteServer, type ServerId } from "./registry.js"
import { serverStore } from "./store.js"

/** The /b50 options, copied out of the slash command so a server pick can resume the same query. */
export type B50Request = {
  userId: string
  commandName: string
  /** The server option as typed; resolution happens in resolveB50Query. */
  explicit: string | null
  sgwcmaid: string | null
  source: string | null
  refresh: boolean | null
  /** false (default): the image is visible only to the caller. true: posted to the channel. */
  public: boolean
  /** true: render at HD_ZOOM (sharper, slower). */
  hd: boolean
}
export type B50Target = { server: ServerId; fromData: boolean }

export function b50Request(interaction: ChatInputCommandInteraction, importing = false): B50Request {
  return {
    userId: interaction.user.id,
    commandName: interaction.commandName,
    explicit: interaction.options.getString("server"),
    sgwcmaid: interaction.options.getString("sgwcmaid", importing),
    source: interaction.options.getString("source"),
    refresh: interaction.options.getBoolean?.("refresh") ?? null,
    public: interaction.options.getBoolean?.("public") ?? false,
    hd: interaction.options.getBoolean?.("hd") ?? false,
  }
}

/** Where a player's data lives. Injected in tests so they do not depend on local binding files. */
export type DataSources = {
  /** A local import record, or a 水鱼 / 落雪 binding: all of them count as cn data. */
  cnData(userId: string): boolean
  /** Servers with live credentials. Unbound servers keep snapshots but do not count. */
  remoteBound(userId: string): RemoteServer[]
}
export const defaultDataSources: DataSources = {
  cnData: userId => scoreDatabase().has(userId) || !!dfBindings.get(userId) || !!lxnsBindings.get(userId),
  remoteBound: userId => serverStore().boundServers(userId),
}

/** Enabled servers where this player has usable data, cn first. */
export function dataServersFor(userId: string, sources: DataSources = defaultDataSources): ServerId[] {
  const servers: ServerId[] = sources.cnData(userId) ? ["cn"] : []
  return [...servers, ...sources.remoteBound(userId)].filter(isEnabledServer)
}

/**
 * An explicit server option wins. sgwcmaid and source:df|lxns can only be cn inputs, so they imply cn.
 * Otherwise the saved /server default, then the single server with data. Returns null when the player must choose.
 */
export function resolveB50Query(req: B50Request, sources: DataSources = defaultDataSources): B50Target | null {
  const cnOnly = !req.explicit && (!!req.sgwcmaid || req.source === "df" || req.source === "lxns")
  const explicit = cnOnly ? "cn" : req.explicit
  const saved = serverStore().savedPreferred(req.userId)
  const server = resolveB50Server(explicit, saved, explicit || saved ? [] : dataServersFor(req.userId, sources))
  return server ? { server, fromData: !explicit && !saved } : null
}
