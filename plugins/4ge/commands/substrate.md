---
description: "Substrate composition engine — render text and OS state through Unicode combining marks, Math Alphanumerics, and block elements. Modes: os, max, palimpsest, alphabets, enclosed, help."
argument-hint: "os | max <word> | palimpsest <base> <overlay> | alphabets <text> | enclosed <base> <shape> | help"
---

Parse $ARGUMENTS:

- If empty or `help`: show the technique summary. See Help section below.
- If `os`: render current HUD state as a substrate scene. See OS mode below.
- If `max <word>`: apply maximum composition treatment to the word. See Max mode below.
- If `palimpsest <base> <overlay>`: stack overlay text on base via combining Latin marks. See Palimpsest mode below.
- If `alphabets <text>`: render input in all 6 Math Alphanumeric alphabets. See Alphabets mode below.
- If `enclosed <base> <shape>`: wrap each character of base with the named enclosing mark. See Enclosed mode below.

Render all output DIRECTLY in your response text. Do NOT use Bash. Do NOT run Node scripts. Compose the output inline using the Unicode techniques below.

---

## OS mode (`/substrate os`)

Load HUD state by reading `_runs/os/health.json`, `_runs/os/boot-status.json`, and `_runs/os/session-meta.json` (use Read tool). Compose a substrate scene that renders:

1. **Session header** — render the session ID in Math Bold, the model name in Math Fraktur, and the context % as a block bar 20 chars wide.
2. **Capability grid** — render each capability name as a palimpsest with a short status word as the combining-mark overlay. Use "ready" where its letters are available, otherwise the raw status. Append an enclosing circle for ready/ok caps and a prohibition mark for failed/degraded caps.
3. **Forge status** — if `.forge-session.json` exists, a forge session is active. Render the phase word in Math Script. Join teammate names with tie ligature half marks.
4. **OS health grade** — render the overall health string in Math Double-Struck.

Use `require('${CLAUDE_PLUGIN_ROOT}/bin/hud-data-loader.cjs')` as a reference for what files to read and how to interpret the data — but do NOT run it. Read the JSON files directly and compose the scene in your response.

---

## Max mode (`/substrate max <word>`)

Apply the maximum composition treatment to `<word>`. Build five layers:

1. Render the base word normally.
2. Overlay combining Latin letters cycling through `c o u r t`. Skip letters outside the available set (a e i o u c d h m r t v x).
3. Scatter diacritics cycling across positions: diaeresis (U+0308), equals-below (U+0347), dot-above (U+0307), low-line (U+0332), ring-above (U+030A).
4. Span adjacent pairs with ligature tie half marks (U+FE20/U+FE21) on even-indexed positions.
5. Place a combining enclosing circle (U+20DD) on the middle character.

Render the result directly in response text. Then show the layer breakdown below it.

Example for "forge":
- Position 0 (f): base + combining-c (U+0368) + diaeresis (U+0308) + tie-left (U+FE20)
- Position 1 (o): base + combining-o (U+0366) + equals-below (U+0347) + tie-right (U+FE21)
- Position 2 (r): base + combining-u (U+0367) + dot-above (U+0307) + circle (U+20DD) [middle]
- Position 3 (g): base + combining-r (U+036C) + low-line (U+0332) + tie-left (U+FE20)
- Position 4 (e): base + combining-t (U+036D) + ring-above (U+030A) + tie-right (U+FE21)

---

## Palimpsest mode (`/substrate palimpsest <base> <overlay>`)

Stack `<overlay>` text as combining Latin small letters (U+0363–U+036F) on top of `<base>` text. Each overlay character that falls in the available 13-letter set (a e i o u c d h m r t v x) is rendered as a combining mark on the corresponding base character. Unavailable overlay characters (b f g j k l n p q s w y z) are silently skipped — the base character appears alone.

Available combining marks and their codepoints:
- a → U+0363, e → U+0364, i → U+0365, o → U+0366, u → U+0367
- c → U+0368, d → U+0369, h → U+036A, m → U+036B, r → U+036C
- t → U+036D, v → U+036E, x → U+036F

Render the composed string directly in response text. Show what the overlay word was and which letters were applied vs skipped.

---

## Alphabets mode (`/substrate alphabets <text>`)

Render `<text>` in all 6 Math Alphanumeric alphabets, one per line, labeled:

```
bold:          𝐟𝐨𝐫𝐠𝐞
italic:        𝑓𝑜𝑟𝑔𝑒
script:        𝒻ℴ𝓇ℊℯ
fraktur:       𝔣𝔬𝔯𝔤𝔢
double-struck: 𝕗𝕠𝕣𝕘𝕖
monospace:     𝚏𝚘𝚛𝚐𝚎
```

Carve-out codepoints for non-contiguous alphabets (use these exact codepoints, not naive offsets):

**Math Script uppercase carve-outs:** B=U+212C, E=U+2130, F=U+2131, H=U+210B, I=U+2110, L=U+2112, M=U+2133, R=U+211B
**Math Script lowercase carve-outs:** e=U+212F, g=U+210A, o=U+2134
**Math Fraktur uppercase carve-outs:** C=U+212D, H=U+210C, I=U+2111, R=U+211C, Z=U+2128
**Math Double-Struck uppercase carve-outs:** C=U+2102, H=U+210D, N=U+2115, P=U+2119, Q=U+211A, R=U+211D, Z=U+2124
**Math Italic lowercase carve-out:** h=U+210E (Planck constant)

Non-alphabetic characters pass through unchanged. Digits are supported in bold, double-struck, and monospace alphabets.

---

## Enclosed mode (`/substrate enclosed <base> <shape>`)

Wrap each character of `<base>` with the named enclosing combining mark. Available shapes:

| Shape       | Codepoint | Appearance |
|-------------|-----------|------------|
| circle      | U+20DD    | ⃝          |
| square      | U+20DE    | ⃞          |
| diamond     | U+20DF    | ⃟          |
| prohibition | U+20E0    | ⃠          |
| keycap      | U+20E3    | ⃣          |
| triangle    | U+20E4    | ⃤          |

Each character in `<base>` gets its own enclosing mark. For multi-character input this creates a sequence of individually enclosed glyphs. Render directly in response text.

---

## Help mode (`/substrate help`)

Output this technique summary directly in response text:

```
/substrate — Unicode substrate composition engine

Modes:
  os                         render current HUD state as a substrate scene
  max <word>                 maximum 6-layer composition on a single word
  palimpsest <base> <over>   overlay text via combining Latin letters (13-letter set)
  alphabets <text>           render in all 6 Math Alphanumeric alphabets
  enclosed <base> <shape>    wrap each char with enclosing mark (circle/square/diamond/keycap/triangle/prohibition)
  help                       this summary

Technique reference:
  Combining Latin Small Letters   U+0363–U+036F   available: a e i o u c d h m r t v x
  Half Marks (ligature spans)     U+FE20–U+FE2F   pairs: tie tilde macron tieBelow solidus
  Enclosing Marks                 U+20DD–U+20E4   circle square diamond prohibition keycap triangle
  Math Bold                       U+1D400–U+1D433 contiguous
  Math Italic                     U+1D434–        h carve-out → U+210E
  Math Script                     U+1D49C–        8 UC + 3 LC carve-outs
  Math Fraktur                    U+1D504–        5 UC carve-outs
  Math Double-Struck              U+1D538–        7 UC carve-outs
  Math Monospace                  U+1D670–        contiguous

Rendering ceiling: ~25-30 combining marks per cell before most fonts clip.
Semantic legibility: 4-6 layers before reader comprehension collapses.
Vertical stack climb: ~30-50 units before fonts stop placing marks.
```
