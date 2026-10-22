// Paste this whole file into Extensions > Apps Script inside the Google Sheet,
// replacing the default Code.gs contents. Then:
//   1. Project Settings > Script Properties > add ANTHROPIC_API_KEY = <your key>
//      (never put this key in the frontend code — it stays server-side here).
//   2. Deploy > New deployment > type "Web app" > Execute as "Me" >
//      Who has access "Anyone" > Deploy > copy the Web App URL.
// See the README section in the chat for the full walkthrough.

const TRAVELERS_SHEET = "Recent travelers details";
const SUBMISSIONS_SHEET = "Submissions";
const DAMAGE_LOG_SHEET = "Baggage damage";
const UPLOADS_FOLDER_NAME = "Baggage damage uploads";
const CLAUDE_MODEL = "claude-opus-5-5";

// Business owner's spec, adapted for this app: the bracketed asset-type
// placeholder is filled in as checked airline baggage, and one scoping
// paragraph is added up front so the AI only assesses the photo(s) labeled
// as damage evidence — not the baggage tag / brand label identification
// photos. Each photo is labeled by role right before it in the message
// content (see handleAnalyse). The model is required to return ONLY JSON;
// parseAssessment() below parses that JSON directly (no regex extraction).
const DAMAGE_SYSTEM_PROMPT = [
  "You are an expert damage assessor and image-authenticity analyst. Analyze the attached image(s) of checked airline baggage (a suitcase or bag). Optional context from the user: none.",
  "",
  "Each photo below is preceded by a text label stating its role. Photos labeled \"Baggage Tag\" or \"Brand Label\" are provided ONLY to help identify which bag this claim is about — do not assess them for damage or authenticity, and do not mention them in your output. Only the photo(s) labeled \"Close-up of Damage\" or \"Additional damage evidence\" are the subject of the damage assessment and authenticity check below. If no photo is labeled as damage evidence, classify damage as \"uncertain\" and explain why in reasoning.",
  "",
  "Do two independent analyses, then combine them into one final recommendation.",
  "",
  "## 1. DAMAGE ASSESSMENT",
  "First describe only what is visible: damaged parts, damage type (scratch, dent, crack, shattered glass, deformation, broken or missing part, rust, fire or water damage), size, and location.",
  "",
  "Classify as:",
  "- MAJOR if any of these is present: structural or frame deformation; crumpled panels or misaligned gaps; damage to safety-critical parts (airbags, windshield, wheels, suspension, brakes, lights); fluid leaks; exposed or broken mechanical or electrical parts; damage covering roughly a third of a panel or more; fire, flood, or severe impact; missing or detached parts.",
  "- MINOR only if ALL hold: surface-level damage (light scratches, scuffs, small dents, paint chips); no structural deformation; no broken safety-critical parts; small area; repairable by simple work.",
  "- UNCERTAIN if the image is blurry, dark, distant, or hides the damaged area, or if internal damage is likely.",
  "When torn between minor and major, choose the more cautious class and explain why.",
  "",
  "## 2. AUTHENTICITY CHECK",
  "Look for signs the image is AI-generated or edited. Report only anomalies you can actually see, and say where in the image.",
  "- Lighting and shadows: wrong light direction, shadows that do not match, missing contact shadows",
  "- Reflections: glass or shiny paint that does not reflect the surroundings logically",
  "- Edges and blending: halos, sharpness or blur mismatches around the damage, pasted-looking patches, cloned textures",
  "- Physical plausibility: dent or crumple shape that does not match the impact, unnatural debris, painted-on rust or water marks",
  "- Text and details: warped plates, logos, badges, signs, or dashboard text; wrong counts of spokes, bolts, or fingers; asymmetry where symmetry is expected",
  "- Texture and noise: waxy or overly smooth surfaces, uniform noise, noise that differs between regions",
  "- Scene consistency: weather, time of day, perspective, or scale that conflict",
  "- Compression: different compression or pixel size in different regions",
  "- Context: does the damage match the stated story, location, and date?",
  "",
  "Rate authenticity as: likely_genuine, suspicious, likely_manipulated_or_ai, or cannot_determine (low resolution, screenshots, heavy compression, or too little detail).",
  "",
  "## 3. COMBINE",
  "- Judge severity and authenticity separately. A genuine photo can show major damage, and a manipulated photo can show minor damage.",
  "- If authenticity is suspicious or worse, state that the damage classification is conditional on the image being real.",
  "- Choose a recommended action: process, request_more_evidence, escalate_to_human, or hold.",
  "",
  "## RULES",
  "- Never claim certainty. Visual analysis cannot prove an image is real or fake; give indicators and risk levels, not verdicts.",
  "- Do not accuse the submitter of fraud. Flag the image for review and cite the evidence.",
  "- Real photos can look odd (low light, lens distortion, compression) and AI images can look perfect, so weigh evidence rather than impressions.",
  "- Do not invent damage or anomalies. If you see none, say so.",
  "- If more photos would help, name the exact angles (close-up, wide shot, underside, interior, plate or VIN).",
  "- Do not give repair costs unless asked.",
  "",
  "## OUTPUT",
  "Return ONLY valid JSON, no text before or after:",
  "{",
  "  \"damage\": {",
  "    \"classification\": \"minor | major | uncertain\",",
  "    \"confidence\": \"high | medium | low\",",
  "    \"damaged_parts\": [{\"part\": \"\", \"damage_type\": \"\", \"severity\": \"low | medium | high\"}],",
  "    \"reasoning\": \"\",",
  "    \"possible_hidden_damage\": []",
  "  },",
  "  \"authenticity\": {",
  "    \"rating\": \"likely_genuine | suspicious | likely_manipulated_or_ai | cannot_determine\",",
  "    \"confidence\": \"high | medium | low\",",
  "    \"anomalies\": [{\"category\": \"\", \"location\": \"\", \"description\": \"\"}],",
  "    \"supporting_signs\": [],",
  "    \"limitations\": []",
  "  },",
  "  \"additional_photos_needed\": [],",
  "  \"verification_steps\": [\"e.g. request original file with metadata\", \"reverse image search\", \"on-site inspection\"],",
  "  \"recommended_action\": \"process | request_more_evidence | escalate_to_human | hold\",",
  "  \"summary\": \"2 to 3 plain sentences covering the damage level, the authenticity risk, and the next step. State that this is a visual estimate, not a professional inspection.\"",
  "}",
].join("\n");

function doGet(e) {
  const bookingRef = (e.parameter.bookingRef || "").trim().toUpperCase();
  const lastName = (e.parameter.lastName || "").trim().toLowerCase();

  if (!bookingRef || !lastName) {
    return jsonResponse({ found: false, error: "bookingRef and lastName are required" });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TRAVELERS_SHEET);
  if (!sheet) {
    return jsonResponse({ found: false, error: "Travelers sheet not found" });
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowBookingRef = String(row[0]).trim().toUpperCase();
    const rowLastName = String(row[2]).trim().toLowerCase();
    if (rowBookingRef === bookingRef && rowLastName === lastName) {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index];
      });
      return jsonResponse({ found: true, record: record });
    }
  }

  return jsonResponse({ found: false });
}

function doPost(e) {
  const payload = JSON.parse(e.postData.contents);
  if (payload.action === "analyse") {
    return handleAnalyse(payload);
  }
  return handleSubmit(payload);
}

// ---- AI damage + authenticity analysis (per bag, called right after the 3 required uploads) ----

function handleAnalyse(payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) {
    const result = { error: "ANTHROPIC_API_KEY is not set in Script Properties" };
    logDamageAssessment(payload, result, "");
    return jsonResponse(result);
  }

  // Image order is fixed by the frontend's upload form: 0 = Baggage Tag,
  // 1 = Brand Label, 2 = Close-up of Damage, 3+ = optional additional
  // damage photos. Label each one by role so the prompt's scoping
  // paragraph can tell the AI which photos to actually analyze.
  const IMAGE_LABELS = ["Baggage Tag", "Brand Label", "Close-up of Damage"];
  const images = payload.images || [];
  const content = [];
  images.forEach((image, index) => {
    const label = IMAGE_LABELS[index] || `Additional damage evidence #${index - 2}`;
    content.push({ type: "text", text: `Photo ${index + 1} — ${label}` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType || "image/jpeg",
        data: image.base64,
      },
    });
  });
  content.push({
    type: "text",
    text: "Assess this baggage per your instructions, using only the photo(s) labeled as damage evidence. Return ONLY the JSON object specified in OUTPUT.",
  });

  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      // Opus 5.5 spends some of its budget on internal reasoning before the
      // visible report; leave real headroom for both the reasoning and the
      // (now fairly large) JSON output.
      max_tokens: 4096,
      system: DAMAGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: content }],
    }),
    muteHttpExceptions: true,
  });

  const body = JSON.parse(response.getContentText());
  if (body.error) {
    const result = { error: body.error.message || "AI analysis failed" };
    logDamageAssessment(payload, result, "");
    return jsonResponse(result);
  }

  // Don't assume the text reply is content[0] — some responses include a
  // non-text block (e.g. thinking) before the actual text block.
  const blocks = body.content || [];
  const textBlock = blocks.find((block) => block.type === "text");
  const text = textBlock ? textBlock.text : "";

  if (!text) {
    const result = { error: "AI returned no text content" };
    logDamageAssessment(payload, result, JSON.stringify(body));
    return jsonResponse(result);
  }

  const result = parseAssessment(text);
  logDamageAssessment(payload, result, text);
  return jsonResponse(result);
}

// The new prompt requires the model to return ONLY a JSON object (see the
// OUTPUT section of DAMAGE_SYSTEM_PROMPT) instead of the old free-text
// report, so this is a direct JSON.parse rather than regex extraction.
// Maps the model's richer {damage, authenticity, recommended_action, ...}
// shape onto the simple {status | flagged | error} shape the frontend
// branches on:
//   recommended_action "process" + damage major/minor -> status
//   recommended_action "request_more_evidence"         -> error (retry)
//   anything else (escalate_to_human, hold, or an               -> flagged
//   unparseable/uncertain result)                                  (manual review)
function parseAssessment(text) {
  let data;
  try {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "");
    data = JSON.parse(cleaned);
  } catch (err) {
    return { error: "Could not parse the AI's JSON response." };
  }

  const damage = data.damage || {};
  const authenticity = data.authenticity || {};
  const action = data.recommended_action;
  const summary = data.summary || "";

  if (action === "process" && (damage.classification === "major" || damage.classification === "minor")) {
    return {
      status: damage.classification,
      damageConfidence: damage.confidence || "",
      authenticity: authenticity.rating || "",
      confidence: authenticity.confidence || "",
      summary: summary,
    };
  }

  if (action === "request_more_evidence") {
    return {
      error:
        summary ||
        "The AI needs clearer or additional photos to assess this damage reliably.",
    };
  }

  // escalate_to_human, hold, an "uncertain" damage classification, or any
  // other combination the rules above didn't match — route to manual
  // review rather than guessing.
  return {
    flagged: true,
    damageConfidence: damage.confidence || "",
    authenticity: authenticity.rating || "Unknown",
    confidence: authenticity.confidence || "",
    summary: summary,
  };
}

function logDamageAssessment(payload, result, rawText) {
  const sheet = getOrCreateDamageLogSheet();
  sheet.appendRow([
    new Date(),
    payload.bookingRef || "",
    payload.bagId || "",
    result.error ? "error" : result.flagged ? "flagged" : result.status || "",
    result.status || "",
    result.damageConfidence || "",
    result.authenticity || "",
    result.confidence || "",
    result.summary || result.error || "",
    rawText,
  ]);
}

function getOrCreateDamageLogSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(DAMAGE_LOG_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DAMAGE_LOG_SHEET);
    sheet.appendRow([
      "Timestamp", "Booking Reference", "Bag ID", "Recommended Action",
      "Damage Classification", "Damage Confidence", "Authenticity Rating",
      "Authenticity Confidence", "Summary", "Full AI Report",
    ]);
  }
  return sheet;
}

// ---- Final claim submission (one or more bags, saved together) ----

function handleSubmit(payload) {
  const sheet = getOrCreateSubmissionsSheet();
  const folder = getOrCreateUploadsFolder();
  const submittedAt = new Date();
  const bags = payload.bags || [];

  bags.forEach((bag) => {
    const imageLinks = (bag.images || []).map((image) => {
      const blob = Utilities.newBlob(
        Utilities.base64Decode(image.base64),
        image.mimeType || "image/jpeg",
        `${bag.bagId || "bag"}_${image.name || "upload.jpg"}`
      );
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return file.getUrl();
    });

    sheet.appendRow([
      submittedAt,
      payload.bookingRef || "",
      payload.firstName || "",
      payload.lastName || "",
      payload.flightNumber || "",
      bag.bagId || "",
      bag.status || "",
      payload.compensationType || "",
      bag.amount || "",
      bag.outcome || "",
      imageLinks.join(", "),
    ]);
  });

  return jsonResponse({ ok: true, bagsSaved: bags.length });
}

function getOrCreateSubmissionsSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SUBMISSIONS_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SUBMISSIONS_SHEET);
    sheet.appendRow([
      "Submitted At", "Booking Reference", "First Name", "Last Name",
      "Flight Number", "Bag ID", "Bag Status", "Compensation Type",
      "Amount", "Outcome", "Image Links",
    ]);
  }
  return sheet;
}

function getOrCreateUploadsFolder() {
  const folders = DriveApp.getFoldersByName(UPLOADS_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(UPLOADS_FOLDER_NAME);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
