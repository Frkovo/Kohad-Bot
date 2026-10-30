// 命令定义。注意：Discord 要求 CHAT_INPUT 命令名必须全小写（官方命名规则），
// 因此 /getUserAll → getuserall、/toMunet → tomunet。
import { SlashCommandBuilder, type SlashCommandStringOption } from "discord.js"
import { SERVER_CHOICES } from "./multiserver/registry.js"
import { t } from "./messages.js"
const serverOption = (o: SlashCommandStringOption) => o.setName("server").setDescription(t("command.option.server")).addChoices(...SERVER_CHOICES)

const sgwcOption = (o: SlashCommandStringOption) => o
  .setName("sgwcmaid")
  .setDescription(t("command.option.qr"))
  .setRequired(true)
  .setMinLength(1)
  .setMaxLength(6000)

export const COMMANDS_JSON = [
  new SlashCommandBuilder().setName("server").setDescription(t("command.server")).addStringOption(serverOption),
  new SlashCommandBuilder().setName("bind").setDescription(t("command.bind")).addStringOption(serverOption),
  new SlashCommandBuilder().setName("sync").setDescription(t("command.sync")).addStringOption(serverOption),
  new SlashCommandBuilder().setName("unbind").setDescription(t("command.unbind")).addStringOption(serverOption),
  new SlashCommandBuilder().setName("help").setDescription(t("command.help")),
  new SlashCommandBuilder()
    .setName("getuserall")
    .setDescription(t("command.getuserall"))
    .addStringOption(sgwcOption),
  new SlashCommandBuilder()
    .setName("tomunet")
    .setDescription(t("command.tomunet"))
    .addStringOption(sgwcOption),
  new SlashCommandBuilder()
    .setName("binddf")
    .setDescription(t("command.binddf")),
  new SlashCommandBuilder()
    .setName("bindlx")
    .setDescription(t("command.bindlx"))
    .addStringOption(o => o.setName("method").setDescription(t("command.bindlx.method")).addChoices({ name: t("command.bindlx.friendCode"), value: "friend_code" })),
  new SlashCommandBuilder()
    .setName("opt")
    .setDescription(t("command.opt")),
  new SlashCommandBuilder()
    .setName("upload")
    .setDescription(t("command.upload"))
    .addStringOption(sgwcOption),
  new SlashCommandBuilder()
    .setName("b50")
    .setDescription(t("command.b50"))
    .addStringOption(serverOption)
    .addBooleanOption(o => o.setName("refresh").setDescription(t("command.b50.refresh")))
    .addStringOption(o => o
      .setName("sgwcmaid")
      .setDescription(t("command.b50.sgwcmaid"))
      .setRequired(false)
      .setMinLength(1)
      .setMaxLength(6000))
    .addStringOption(o => o.setName("source").setDescription(t("command.b50.source")).addChoices(
      { name: t("command.choice.auto"), value: "auto" },
      { name: t("command.choice.localDb"), value: "local" },
      { name: t("command.choice.df"), value: "df" },
      { name: t("command.choice.lxns"), value: "lxns" },
      { name: t("command.choice.net"), value: "net" },
    ))
    .addBooleanOption(o => o.setName("public").setDescription(t("command.public")))
    .addBooleanOption(o => o.setName("hd").setDescription(t("command.hd"))),
  ...["nb50", "pc50"].map(name => new SlashCommandBuilder().setName(name)
    .setDescription(name === "nb50" ? t("command.nb50") : t("command.pc50"))
    .addStringOption(serverOption)
    .addBooleanOption(o => o.setName("refresh").setDescription(t("command.refreshServer")))
    .addStringOption(o => o.setName("source").setDescription(t("command.source")).addChoices(
      { name: t("command.choice.auto"), value: "auto" },
      { name: t("command.choice.localCache"), value: "local" },
    ))
    .addStringOption(o => o.setName("sgwcmaid").setDescription(t("command.nbSgwcmaid")).setMinLength(1).setMaxLength(6000))
    .addBooleanOption(o => o.setName("public").setDescription(t("command.public")))
    .addBooleanOption(o => o.setName("hd").setDescription(t("command.hd")))),
].map(c => c.toJSON())

export const COMMAND_NAMES = COMMANDS_JSON.map(c => c.name)
