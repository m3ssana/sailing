# Art Direction — Normative

This document is **normative**. Every render and generation agent works against it. If your output contradicts this document, the output is wrong.

---

## 1. Intent

Procedural generation cannot win a detail race against authored art. It can, however, produce forms that are clean, parametrically consistent, and perfectly coherent with the physics driving them. Stylized realism exploits that strength: physically based lighting on simplified geometry with curated colour. The result is a game that looks *confident* rather than *incomplete*.

The target sits between two failure modes:

- **Photorealism** demands micro-detail, grunge, and complexity that generators cannot deliver — every surface screams "placeholder."
- **Cel-shading / toon** breaks the PBR pipeline, makes water look flat, and fights the atmospheric rendering that sells the ocean.

Stylized realism keeps PBR intact (correct energy conservation, ACES tonemapping, IBL) and concentrates rendering fidelity on water, foam, spray, sky, and light — domains where simulation-driven procedural techniques genuinely surpass authored assets. Everything else is deliberately simpler, so the eye reads the scene as intentionally styled rather than unfinished.

---

## 2. Form language

### 2.1 Silhouette-first

Every generated object must read correctly as a silhouette at 2 km against sky. If the shape is unrecognizable without shading, it fails. Test by rendering flat black against a white background at the intended viewing distance.

### 2.2 Chamfers and edges

No razor-sharp edges. Chamfer or fillet every convex edge at **1–2% of the object's major dimension** (e.g., a 12 m hull gets 12–24 cm chamfers on deck edges, a 1.5 m winch drum gets 1.5–3 cm). This catches specular highlights that sell the form and prevents aliasing on thin silhouettes.

### 2.3 Polygon density by object class

| Object class | Triangle budget | Notes |
|---|---|---|
| Player hull | 6,000–10,000 | Smooth sheerline and waterline curvature are paramount. |
| Player rig (mast + boom + rigging) | 2,000–4,000 | Tapered tube resolution matters at spreaders. |
| Player sails (per sail) | 800–1,200 | Doubles as PBD cloth grid — resolution serves physics. |
| Fleet boat (tier 1–2) | 2,000–4,000 | Simplified deck detail, shared hull LOD. |
| Fleet boat (tier 3) | 400–800 | Silhouette only. |
| Landmark (bridge, building) | 3,000–8,000 | Profile and proportion, not surface detail. |
| Terrain tile | 4,000–8,000 | Heightfield grid; smooth coastline edge is critical. |
| Navigation buoy | 100–200 | Cylinder + cone + light. |
| Ambient vessel | 500–1,500 | Profile recognition from the water. |

### 2.4 What to omit

- No micro-detail: no bolts, screws, hinges, seams shorter than 5 cm, lettering geometry.
- No grunge, wear, dirt, rust, or staining — surfaces are clean and new.
- No surface decals or logos as geometry. Sail numbers use flat colour regions on the sail grid.
- No interior modelling. Cockpits are a flat sole + coaming silhouette.
- No rigging hardware geometry (blocks, clutches) — rigging lines terminate at deck level.

---

## 3. Surface and material rules

### 3.1 Principle

Broad regions of confident, saturated colour. Materials are identified by their **roughness and reflectance**, not by noisy surface variation. A hull is one colour from bow to transom. A deck is one colour across its entire area. Variation comes from form, lighting, and Fresnel — not from painted-on complexity.

### 3.2 Roughness ranges by material family

| Material | Roughness | Metalness | Notes |
|---|---|---|---|
| Gelcoat (hull, deck) | 0.25–0.35 | 0.0 | Smooth gloss. Subtle orange-peel normal perturbation at 0.002 amplitude max. Flake sparkle in metallic colours only. |
| Carbon fibre | 0.20–0.30 | 0.0 | Weave pattern from a rotated-checker basis at very low amplitude. Viewed > 5 m, reads as smooth dark surface. |
| Anodized aluminium (spars) | 0.35–0.45 | 0.8 | Matte metallic. No scratches, no corrosion. |
| Stainless / chrome (fittings) | 0.15–0.25 | 1.0 | Only where the silhouette benefits from a bright highlight (winch drums, stanchion tops). |
| Sailcloth | 0.70–0.85 | 0.0 | Matte, translucent. Panel seam lines as subtle darkening, not geometry. Visible warp/weft only on close inspection (< 3 m). |
| Teak (deck trim) | 0.55–0.70 | 0.0 | Banded noise along the grain. Max 3 visible bands per plank. No knots. |
| Terrain — rock/earth | 0.75–0.90 | 0.0 | Colour by altitude and slope. No displacement mapping. |
| Terrain — sand/beach | 0.85–0.95 | 0.0 | Warm neutral, slightly lighter than water at the tideline. |
| Concrete (seawalls, docks) | 0.80–0.90 | 0.0 | Flat grey. No cracks, no staining. |
| Water (surface) | 0.0–0.05 | 0.0 | GGX specular from wind-roughened normals — effectively variable. |

### 3.3 Procedural variation limits

- **Spatial noise on roughness:** maximum ±0.05 from the base value.
- **Colour variation within one region:** maximum ±3% lightness, ±2° hue shift.
- **No noise octaves above 4.** High-frequency noise reads as dirt.
- **Wetness darkening:** up to 30% reduction in albedo where spray lands, with a 5-second exponential dry-off. Roughness drops by 0.15 when wet.

### 3.4 Forbidden patterns

- No tiled textures or visible repeat.
- No Perlin/simplex noise applied directly as albedo variation (reads as mould).
- No ambient occlusion baked into vertex colour — use SSAO or nothing.
- No emissive materials except navigation lights, instrument backlights, and shore windows at night.


---

## 4. Venue palettes

Each venue has a curated palette that makes it visually distinct from every other. A player should recognise the venue from a screenshot's colour alone. The palette drives the procedural colour grade (the `ColorGradeParams.palette` field in `VenueDefinition`) and constrains every material in the scene.

Hex values below are in **sRGB** for human readability. Implementation converts to linear RGB via `sRGBToLinear()` before use.

### 4.1 Newport, Rhode Island

Cold green-grey Atlantic, grey shingle shoreline, weathered New England clapboard. Overcast maritime light.

| Role | Name | Hex |
|---|---|---|
| Deep water | Narragansett Deep | `#2B4A4F` |
| Shallow water | Bay Green | `#4A7068` |
| Sky base | Atlantic Overcast | `#8A9EAB` |
| Land primary | Shingle Grey | `#6B7178` |
| Vegetation | Salt Marsh | `#5C7A5A` |
| Architecture | Clapboard White | `#D8DDE0` |
| Accent | Lighthouse Red | `#8B3A3A` |

- Shallow water: `#4A7068` | Deep water: `#2B4A4F` | Turbidity: **0.45**

---

### 4.2 San Francisco Bay

Cold Pacific blue-grey, brown-golden hills, iconic fog. Strong afternoon light cuts through marine haze.

| Role | Name | Hex |
|---|---|---|
| Deep water | Pacific Slate | `#1E3A4D` |
| Shallow water | Bay Chop | `#3D6B78` |
| Sky base | Fog Silver | `#B8C4CC` |
| Land primary | Golden Hill | `#A08850` |
| Headland | Marin Ochre | `#7A6B42` |
| Architecture | Bridge Vermillion | `#C1440E` |
| Accent | Alcatraz Buff | `#C8B896` |

- Shallow water: `#3D6B78` | Deep water: `#1E3A4D` | Turbidity: **0.40**

---

### 4.3 Sydney Harbour

Warm deep blue harbour, sandstone headlands, bright Antipodean light. High contrast, vivid sky.

| Role | Name | Hex |
|---|---|---|
| Deep water | Harbour Blue | `#1A3F6B` |
| Shallow water | Manly Turquoise | `#3A8B8F` |
| Sky base | Southern Clear | `#6BA8D4` |
| Land primary | Sandstone Warm | `#C4A060` |
| Vegetation | Eucalypt | `#4A7A4A` |
| Architecture | Opera Shell | `#E8E4DC` |
| Accent | Ferry Green | `#2D6B4A` |

- Shallow water: `#3A8B8F` | Deep water: `#1A3F6B` | Turbidity: **0.30**

---

### 4.4 Auckland, Hauraki Gulf

Deep Pacific blue, volcanic dark islands, lush subtropical green. Warm, saturated light.

| Role | Name | Hex |
|---|---|---|
| Deep water | Hauraki Blue | `#143858` |
| Shallow water | Gulf Teal | `#2E7A80` |
| Sky base | Kiwi Azure | `#5EA0C8` |
| Land primary | Volcanic Dark | `#3A3A32` |
| Vegetation | Pohutukawa Green | `#2E6B3A` |
| Coast | Black Sand | `#2A2A28` |
| Accent | Waka Red | `#9B2C2C` |

- Shallow water: `#2E7A80` | Deep water: `#143858` | Turbidity: **0.25**

---

### 4.5 The Solent

Grey-green English Channel, chalk cliffs, overcast diffuse light. Low saturation, high atmospheric perspective.

| Role | Name | Hex |
|---|---|---|
| Deep water | Channel Grey | `#3A5258` |
| Shallow water | Solent Green | `#5A8A7A` |
| Sky base | Hampshire Overcast | `#9AA4A8` |
| Land primary | Chalk White | `#D8D4C8` |
| Vegetation | Downland | `#5A7A50` |
| Architecture | Cowes Cream | `#E0D8C4` |
| Accent | Spinnaker Tower Blue | `#4070A0` |

- Shallow water: `#5A8A7A` | Deep water: `#3A5258` | Turbidity: **0.50**

---

### 4.6 Kiel Bay

Grey Baltic water, flat northern light, red-brick shoreline. Cool and desaturated.

| Role | Name | Hex |
|---|---|---|
| Deep water | Baltic Steel | `#2E4048` |
| Shallow water | Kiel Grey-Green | `#4A6A62` |
| Sky base | Northern Flat | `#A0AAB0` |
| Land primary | Brick Red | `#8A5040` |
| Vegetation | Baltic Pine | `#3A5A3A` |
| Coast | Sand Beige | `#B8A888` |
| Accent | Signal Yellow | `#C8A820` |

- Shallow water: `#4A6A62` | Deep water: `#2E4048` | Turbidity: **0.55**


---

### 4.7 Palma Bay, Mallorca

Clear Mediterranean blue, limestone coast, intense southern sun. High saturation, warm.

| Role | Name | Hex |
|---|---|---|
| Deep water | Med Deep | `#0E3B6E` |
| Shallow water | Cala Turquoise | `#28A0A0` |
| Sky base | Balearic Blue | `#4A98D4` |
| Land primary | Limestone Warm | `#D4C4A0` |
| Vegetation | Mediterranean Pine | `#3A6840` |
| Architecture | Sandstone | `#D8C090` |
| Accent | Terracotta | `#B86840` |

- Shallow water: `#28A0A0` | Deep water: `#0E3B6E` | Turbidity: **0.15**

---

### 4.8 Valencia

Warm Mediterranean blue-green, flat sandy coast, harsh midday light. Brighter and flatter than Palma.

| Role | Name | Hex |
|---|---|---|
| Deep water | Valencian Blue | `#1A4878` |
| Shallow water | Playa Aqua | `#38A0A8` |
| Sky base | Levante Clear | `#5AACDC` |
| Land primary | Beach Sand | `#D8C8A0` |
| Urban | Marina White | `#E0E0DC` |
| Vegetation | Citrus Green | `#4A8040` |
| Accent | AC Red | `#C83030` |

- Shallow water: `#38A0A8` | Deep water: `#1A4878` | Turbidity: **0.20**

---

### 4.9 Victoria Harbour, Hong Kong

Murky green harbour water, dense vertical skyline, hazy subtropical light. Warm grey atmospheric perspective.

| Role | Name | Hex |
|---|---|---|
| Deep water | Harbour Jade | `#1A3A3A` |
| Shallow water | Kowloon Green | `#3A6858` |
| Sky base | Subtropical Haze | `#8AA0A8` |
| Land primary | Granite Peak | `#5A5A58` |
| Skyline | Glass Tower | `#7898B0` |
| Vegetation | Tropical Dense | `#2A5A2A` |
| Accent | Junk Sail Red | `#A83020` |

- Shallow water: `#3A6858` | Deep water: `#1A3A3A` | Turbidity: **0.60**

---

### 4.10 Guanabara Bay, Rio de Janeiro

Warm murky green-brown water, dramatic green mountains, tropical glare. High turbidity, high saturation on land.

| Role | Name | Hex |
|---|---|---|
| Deep water | Guanabara Dark | `#2A4038` |
| Shallow water | Bay Warm Green | `#4A7A58` |
| Sky base | Tropical Bright | `#68B0D8` |
| Land primary | Granite Green | `#3A6A40` |
| Peak | Sugarloaf Grey | `#6A6A60` |
| Beach | Copacabana Sand | `#E0D0A8` |
| Accent | Favela Colour | `#D88040` |

- Shallow water: `#4A7A58` | Deep water: `#2A4038` | Turbidity: **0.70**

---

### 4.11 Table Bay, Cape Town

Cold blue-green Atlantic, grey granite mountain, austere southern light. Strong value contrast between dark mountain and bright sky.

| Role | Name | Hex |
|---|---|---|
| Deep water | Atlantic Cold | `#1A3848` |
| Shallow water | Kelp Green | `#2A6A68` |
| Sky base | Cape Clear | `#6098C0` |
| Land primary | Table Grey | `#5A5A5A` |
| Cliff face | Granite Dark | `#3A3A38` |
| Vegetation | Fynbos Sage | `#6A8A5A` |
| Accent | Robben Lighthouse | `#E8E0D0` |

- Shallow water: `#2A6A68` | Deep water: `#1A3848` | Turbidity: **0.35**

---

### 4.12 Lake Michigan / Chicago

Fresh water — distinctly different blue-green from any saltwater venue. Flat horizon, dramatic urban skyline, midwestern light.

| Role | Name | Hex |
|---|---|---|
| Deep water | Michigan Blue-Green | `#1A4858` |
| Shallow water | Lakefront Teal | `#3A8880` |
| Sky base | Prairie Sky | `#6AA8C8` |
| Land primary | Lakeshore Concrete | `#8A8A88` |
| Skyline | Steel and Glass | `#607080` |
| Park | Lincoln Green | `#4A7848` |
| Accent | Navy Pier Red | `#A83838` |

- Shallow water: `#3A8880` | Deep water: `#1A4858` | Turbidity: **0.35**

Fresh-water note: Lake Michigan's blue-green has more green saturation and less grey than comparable-depth saltwater venues. The absence of salt reduces scattering, producing a cleaner, more vitreous transparency in shallow areas. Use `freshwater: true` in the venue definition to signal different absorption coefficients.


---

## 5. Lighting and exposure

### 5.1 Pipeline

All lighting is physically based. The stylization target never justifies breaking PBR.

- **Colour space:** linear sRGB workspace throughout. sRGB encoding only at final output.
- **Tonemapping:** ACES Filmic (the three.js `ACESFilmicToneMapping`). No other operator.
- **HDR targets:** all render targets are float16 minimum.
- **IBL:** PMREM-filtered cubemap of the procedural sky. Regenerated only when sun elevation changes > 2° or cloud cover shifts > 10%.

### 5.2 Exposure

| Condition | Exposure (EV) | Notes |
|---|---|---|
| Bright midday, clear | 14.0–15.0 | Beach and white sails just below clipping. |
| Overcast day | 12.0–13.0 | Flatter, but ocean glitter still blooms. |
| Golden hour | 11.0–12.5 | Warm, long shadows, strong rim. |
| Twilight / blue hour | 8.0–10.0 | Transition, city lights begin. |
| Night, full moon | 4.0–6.0 | Moonlit water visible, deep shadows. |
| Night, no moon | 2.0–4.0 | Navigation lights dominate. |

Auto-exposure is **disabled**. Exposure is set from solar elevation via a lookup curve, so all venues at the same time-of-day have consistent brightness. The curve is monotonic and smooth — no pulsing, no adaptation lag.

### 5.3 Venue colour grade

Applied as a TSL post-process node, not an image LUT. Parameters per venue (`ColorGradeParams`):

1. **Shadow tint** — cool shift toward the venue's deep-water colour in shadows.
2. **Highlight tint** — warm shift toward the venue's sky base in highlights.
3. **Saturation** — 0.9–1.1 range. Never oversaturated.
4. **Contrast** — subtle S-curve, never crushing blacks or blowing whites.
5. **Palette enforcement** — a soft clamp that gently pulls out-of-palette hues toward the nearest palette entry. Strength ≤ 0.15 so it tints rather than posterizes.

The grade must be subtle enough that a white sail still reads as white and a black carbon mast still reads as black. If the grade makes neutral objects look tinted, it is too strong.

### 5.4 Silhouette separation

No outlines. No toon ramps. Separation comes from:

1. **Rim lighting** — a half-Fresnel term added to all opaque materials, using the sky's ambient colour. Intensity 0.15–0.30, visible only at grazing angles against dark backgrounds (e.g., dark hull against dark water). This is subtle — if a player notices "there's a rim light," it's too strong.

2. **Aerial perspective** — objects fade toward the venue's sky base colour with distance. Start at 500 m, reach 60% blend at 5 km. This is the primary depth cue beyond 1 km and the reason distant landmarks read as silhouettes against the atmosphere.

3. **Value separation** — the colour grade's shadow tint and the sky's ambient ensure that objects in shadow remain distinguishable from the water surface. If a dark hull vanishes against dark water, the shadow tint needs more blue shift.

---

## 6. Proportion heightening

Gentle exaggeration of visual proportions is permitted to improve readability at speed and distance. **Physics is never exaggerated** — heightening is a render-layer visual offset only.

### 6.1 Allowed amplifications

| Element | Max amplification | Method |
|---|---|---|
| Heel angle (visual) | +15% of true physics value | Render-side roll offset added to the interpolated boat transform. |
| Sail camber depth (visual) | +10% of true cloth shape | Vertex offset along the sail normal in the sail renderer. |
| Spray volume | +50% more particles than physics-justified | Particle count multiplier in the spray emitter. |
| Wake foam width | +20% of true hull beam | Foam injection width in the wake renderer. |
| Bow wave height | +25% of true displacement | Vertex displacement in the bow-wave geometry. |
| Gust-patch darkness | Not a physical quantity — artistic | Roughness + albedo modulation are free to be stronger than measured. |

### 6.2 Forbidden exaggerations

- **Boat speed** — the visual position must match the physics position exactly. No trail or motion tricks that imply a different speed.
- **Wind strength** — flag and telltale response must track actual apparent wind. Flags may not "over-blow" for drama.
- **Wave height** — rendered wave surface is the physics wave surface. The 5 cm coherence rule (req 4.12) is absolute.
- **Mast height or hull length** — no proportion scaling of the boat itself.
- **Sound** — audio intensity tracks physics quantities, not heightened visuals.

### 6.3 Implementation rule

Every heightening is a named constant (e.g., `VISUAL_HEEL_AMPLIFICATION = 1.15`) defined in a single configuration module, so it can be tuned globally and disabled for a "pure physics view" toggle.


---

## 7. Night

Night is a first-class state, not an edge case. Roughly half of all venues are dark at any given moment. The game does not force daylight.

### 7.1 Moonlight

- **Colour temperature:** 6500 K shifted toward blue — use `#8CA8C8` as the directional light colour at full moon, dimming to `#4A6080` at crescent.
- **Intensity:** 0.02–0.08× the daytime sun intensity, depending on lunar phase. Enough to light the water surface and cast faint shadows, not enough to read by.
- **Specular track:** the moon produces its own glitter trail on the water, using the same GGX path as the sun but dimmed by the intensity ratio.
- **Shadow:** moonlight shadows are optional. If rendered, one CSM cascade only, soft, and faint.

### 7.2 Navigation lights

Per COLREGS, rendered on the player's boat, AI fleet, ambient traffic, and moored vessels:

| Light | Colour (hex) | Arc | Visibility | Notes |
|---|---|---|---|---|
| Port | `#FF0020` | 112.5° from dead ahead to port | 2 nm | Saturated red, small point + glow. |
| Starboard | `#00E040` | 112.5° from dead ahead to starboard | 2 nm | Saturated green, small point + glow. |
| Stern | `#FFFFFF` | 135° | 2 nm | White. |
| Masthead (power) | `#FFFFFF` | 225° | 3 nm | Only on power vessels and anchored boats. |
| All-round anchor | `#FFFFFF` | 360° | 2 nm | On moored/anchored vessels. |

Implement as point emissive + bloom contribution. Light geometry (lens) is not rendered — the bloom halo is the visibility cue.

### 7.3 Shore and harbour lighting

- **Window lights:** sparse emissive rectangles on landmark buildings and shoreline. Density: 10–30% of available window positions filled. Colour: warm white `#FFE0B0` to warm yellow `#FFD080`. Slight random flicker.
- **Street/dock lighting:** point lights along visible roads and quay edges. Colour: sodium `#FFA040` or cool LED `#D0E0F0` depending on venue modernity. Spacing: one per 40–80 m of visible coast.
- **Harbour:** brighter cluster at marina areas — masthead anchor lights on moored yachts, dock edge markers.
- **Total shore light budget:** ≤ 200 emissive points per venue. Instanced. Not shadow-casting.

### 7.4 Stars

- Procedural star field from the ~100 brightest stars (correct positions for venue latitude and sidereal time) plus ~2000 statistical fillers.
- Magnitude-based brightness: brightest stars at intensity 1.0, faintest at 0.05.
- Star colour varies: hot blue-white (`#A8C8FF`) through white to warm orange (`#FFD0A0`).
- Stars are **hidden by cloud cover** — multiply visibility by `1 − cloudCoverHigh`.
- No Milky Way rendering — the statistical filler provides sufficient density.
- Stars contribute to bloom very subtly (≤ 0.1 bloom weight).

### 7.5 Difficulty acknowledgment

Gust patches on the water are far harder to read at night. The surface albedo modulation that shows gusts during the day is barely visible under moonlight. **This is intentional and true to life.** Do not compensate by making gusts artificially visible at night. Skilled players learn to read them from the sound of approaching wind in the rig and from instrument data.


---

## 8. UI visual language

Nautical-instrument inspired. Think marine chronometer, not mobile game. The UI should feel like precision equipment overlaid on nature.

### 8.1 Typography

- **Numerics:** monospace. Use a tabular-figure font (e.g., `JetBrains Mono`, `IBM Plex Mono`, or a system monospace). Numbers must not shift layout when values change.
- **Labels:** proportional sans-serif, light weight (300–400). Clean, geometric faces. No serif, no script, no decorative faces.
- **Sizing:** HUD numerics 14–18 px equivalent at reference resolution. Labels 11–13 px. Never below 11 px.
- **Letter-spacing:** +0.02 em on uppercase labels. Normal on numerics.
- **No text shadows.** Contrast comes from backdrop, not glow effects.

### 8.2 UI colour ramp

| Role | Name | Hex | Usage |
|---|---|---|---|
| Background | Instrument Black | `#0A0E12` | Panel backgrounds, backdrops. |
| Surface | Deep Charcoal | `#1A2028` | Cards, containers. |
| Border | Wire Grey | `#3A4248` | Panel edges, dividers. Stroke weight 1 px. |
| Text primary | Chalk White | `#E8ECF0` | Primary numerics and labels. |
| Text secondary | Muted Grey | `#8A9298` | Secondary info, units, timestamps. |
| Accent primary | Compass Blue | `#3A90D0` | Active selections, interactive elements, focus rings. |
| Accent warn | Caution Amber | `#D8A030` | Approaching limits, advisory. |
| Accent danger | Alert Red | `#D04040` | Collision, penalty, capsize warning. |
| Positive | Starboard Green | `#30A060` | VMG gain, correct tack, course-made-good. |
| Wind indicator | Apparent Cyan | `#40D8E0` | Apparent wind arrow and numerics. |
| True wind | True Blue | `#5888C0` | True wind direction, compass rose. |

### 8.3 Stroke and weight rules

- Panel borders: 1 px, `Wire Grey`.
- Compass rose and gauge arcs: 1.5 px stroke, `Chalk White` for primary, `Muted Grey` for graduations.
- Wind arrow: 2 px stroke, `Apparent Cyan` fill with 80% opacity.
- Course line: 2 px dashed, `Compass Blue`.
- Mark circles: 1.5 px, `Accent primary`.
- No drop shadows on UI elements. No gradients on backgrounds. Flat, high-contrast panels.

### 8.4 HUD-over-water contrast rule

The ocean surface behind HUD elements varies from near-black (deep shadow) to near-white (sun glitter). No transparent overlay is reliably readable across this range. Therefore:

- **Every HUD element MUST offer an opaque backdrop option** (`Instrument Black` at 92% opacity).
- The default is semi-transparent (`Instrument Black` at 75% opacity) for aesthetics.
- The user can toggle to full-opaque via accessibility settings (requirement 12.1).
- Never rely on text colour alone for contrast — always provide the backdrop rectangle.
- Minimum contrast ratio: 4.5:1 (WCAG AA) in the opaque mode, which the palette guarantees (`#E8ECF0` on `#0A0E12` = 16.5:1).

### 8.5 Instrument design principles

- Gauges are circular arcs, not linear bars. Wind angle, boat speed, VMG — all radial.
- Compass uses a traditional card (rotating card, fixed lubber line), not a digital readout.
- Numeric readouts right-align. Units are smaller and in `Muted Grey`, not the same size as the value.
- Animations are critically damped (no overshoot, no bounce). Needles and numbers update at 10 Hz (not frame rate) to avoid jitter.
- No icons where text works. Prefer "TWA" over a wind icon. Abbreviations follow maritime convention: SOG, COG, VMG, TWS, TWA, AWS, AWA, HDG.


---

## 9. Pre-PR checklist

Run this against your own work before opening a pull request. Every item must pass.

- [ ] **Silhouette test.** Render the object flat black on white at its intended max viewing distance. Is it recognizable? If not, the form needs work.
- [ ] **Palette compliance.** Every colour in the scene is either a venue palette entry, a physically derived value (sky, water Fresnel, specular), or a material property within the ranges in §3.2. No mystery colours.
- [ ] **Roughness in range.** Sample 5 points on each material — all roughness values fall within the table in §3.2 ±0.05.
- [ ] **No forbidden patterns.** No grunge, no dirt, no noise-as-albedo, no visible tile repeat, no toon outlines, no emissive (except nav lights / shore windows / instruments).
- [ ] **Chamfer check.** No razor-sharp convex edges visible in the hero camera range (< 50 m).
- [ ] **Triangle budget.** Object triangle count is within the range in §2.3.
- [ ] **Night mode.** Toggle to night. Object is still visible and identifiable under moonlight. Nav lights (if applicable) render correctly with bloom.
- [ ] **Rim light.** Grazing-angle rim is present and subtle. Not visible at direct angles.
- [ ] **Aerial perspective.** Object at 2+ km fades toward sky base. Not a hard silhouette, not invisible.
- [ ] **No physics exaggeration.** Any visual amplification uses a named constant from §6.1 and stays within stated limits. No unlisted amplifications.
- [ ] **Colour grade survives.** Object reads correctly after the venue's procedural colour grade is applied. White stays white-ish, black stays black-ish.
- [ ] **HUD contrast.** If adding UI elements: readable on both sun-glitter white and deep-shadow black backgrounds with opaque backdrop enabled. Verify 4.5:1 ratio.
- [ ] **Backend parity.** Renders without shader errors on both WebGPU and forced WebGL2.
