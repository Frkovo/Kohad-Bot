import { asset, picture, text, credit, renderSvg } from "./theme.js"
import { t } from "../messages.js"

// Command names, colours and steps' ASCII syntax are identifiers; all Chinese copy comes from keys.json.
const COMMAND_SPECS = [
  { slug: "server", command: "/server", color: "#488ddb" },
  { slug: "bind", command: "/bind", color: "#749dc7" },
  { slug: "sync", command: "/sync", color: "#45adc6" },
  { slug: "unbind", command: "/unbind", color: "#d47ca9" },
  { slug: "upload", command: "/upload", color: "#45adc6" },
  { slug: "b50", command: "/b50", color: "#8c62d9" },
  { slug: "nb50", command: "/nb50", color: "#a258d2" },
  { slug: "pc50", command: "/pc50", color: "#d47ca9" },
  { slug: "binddf", command: "/binddf", color: "#488ddb" },
  { slug: "bindlx", command: "/bindlx", color: "#749dc7" },
  { slug: "getuserall", command: "/getuserall", color: "#d19b47" },
  { slug: "tomunet", command: "/tomunet", color: "#c58c55" },
  { slug: "opt", command: "/opt", color: "#e0a54a" },
  { slug: "help", command: "/help", color: "#7c81ff" },
] as const

function helpCommands() {
  return COMMAND_SPECS.map(spec => ({
    command: spec.command,
    color: spec.color,
    title: t(`help.cmd.${spec.slug}.title`),
    lines: [t(`help.cmd.${spec.slug}.line1`), t(`help.cmd.${spec.slug}.line2`)],
    usage: t(`help.cmd.${spec.slug}.usage`),
  }))
}

let cached: Promise<Buffer> | null = null
export function renderHelp(): Promise<Buffer> {
  if (cached) return cached
  const commands = helpCommands()
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1600" viewBox="0 0 1400 1600">`
  svg += picture(asset("pic/prism_plus/b50.png"), 0, 0, 1400, 1600)
  svg += picture(asset("pic/prism_plus/logo.png"), 35, 55, 249, 120)
  svg += `<rect x="320" y="60" width="755" height="130" rx="18" fill="#ffffff" fill-opacity="0.92" stroke="#ffffff" stroke-width="4"/>`
  svg += text(t("help.header.brand"), 353, 116, 37, "#7c81ff")
  svg += text(t("help.header.subtitle"), 354, 159, 24, "#655da8")
  svg += text(t("help.header.label"), 1350, 92, 30, "#7c81ff", 700, "end")
  svg += text(t("help.header.multi"), 1350, 125, 18, "#524b7d", 700, "end")
  svg += text(t("help.quickStart"), 35, 246, 27, "#655da8")
  const steps = [["01", t("help.step.1"), t("help.stepDetail.1")], ["02", t("help.step.2"), t("help.stepDetail.2")], ["03", t("help.step.3"), t("help.stepDetail.3")]]
  steps.forEach(([n,title,detail],i) => {
    const x=35+i*448
    svg += `<rect x="${x}" y="267" width="434" height="102" rx="16" fill="#ffffff" fill-opacity="0.94" stroke="#c3bbf0" stroke-width="2"/>`
    svg += text(n, x+19, 319, 33, "#a395e4")
    svg += text(title, x+84, 307, 24, "#655da8")
    svg += text(detail, x+84, 341, 19, "#655da8", 400)
  })
  svg += text(t("help.allCommands"), 35, 412, 27, "#655da8")
  commands.forEach((c,i) => {
    const x=35+(i%2)*676, y=433+Math.floor(i/2)*145
    const width = commands.length % 2 === 1 && i === commands.length - 1 ? 1330 : 654
    svg += `<rect x="${x}" y="${y}" width="${width}" height="133" rx="14" fill="#ffffff" fill-opacity="0.95" stroke="#ffffff" stroke-width="4"/>`
    svg += `<path d="M${x+14},${y}H${x+width-14}Q${x+width},${y} ${x+width},${y+14}V${y+36}H${x}V${y+14}Q${x},${y} ${x+14},${y}" fill="${c.color}"/>`
    svg += text(c.command, x+17, y+26, 23)
    svg += text(c.title, x+width-24, y+25, 20, "#ffffff", 700, "end")
    c.lines.forEach((line,j) => { svg += text(line, x+18, y+61+j*24, 18, "#524b7d", 400) })
    svg += `<rect x="${x+15}" y="${y+100}" width="${width-30}" height="25" rx="7" fill="#f0edf9"/>`
    svg += text(c.usage, x+25, y+119, 16, c.color)
  })
  svg += text(t("help.footer.qr"), 700, 1468, 20, "#655da8", 700, "middle")
  svg += text(t("help.footer.visibility"), 700, 1500, 19, "#655da8", 400, "middle")
  svg += credit() + "</svg>"
  cached = renderSvg(svg).catch(error => { cached = null; throw error })
  return cached
}
