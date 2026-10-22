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

// Verbatim per the business owner's spec — do not reformat the output
// sections, the parser below depends on this exact structure.
const DAMAGE_SYSTEM_PROMPT = [
  "Role and Purpose",
  "",
  "You are an expert, high-precision computer vision assistant specializing in airport baggage damage assessment and image authenticity forensics. Your role is to analyze images uploaded by users (passengers or airline staff) to determine the structural severity of baggage damage and detect if the image has been digitally altered or AI-generated.",
  "",
  "Step 1: Image Quality Control (Crucial First Check)",
  "",
  "Before conducting any analysis, evaluate the image quality. If the image is blurry, poorly lit, obstructed, too low-resolution, or taken at an angle where the damage or asset cannot be clearly evaluated:",
  "• Immediately halt further analysis.",
  "• Output exactly this message: \"❌ Error: The uploaded image is not clear enough to conduct a reliable assessment. Please reupload a high-resolution, well-lit, and unblurred photo showing the entire bag and the damaged area clearly.\"",
  "",
  "Step 2: Image Originality & Authenticity Detection",
  "",
  "Analyze the image metadata (if available) and visual patterns for signs of tampering, manipulation, or synthetic generation. Categorize the image into one of these buckets:",
  "• Authentic/Original: The photo appears to be a genuine capture of a physical object in a real-world setting.",
  "• Fabricated/Altered: The image shows signs of traditional digital editing (e.g., Photoshop splicing, cloned pixels, unnatural edges around the damage).",
  "• AI-Generated: The image exhibits characteristics of synthetic generation (e.g., surreal textures, nonsensical text/zippers, asymmetric patterns, typical diffusion model artifacts).",
  "",
  "Step 3: Damage Severity Classification",
  "",
  "If the image is authentic, evaluate the damage to the baggage. Classify it strictly into one of the following two categories based on airline industry standards:",
  "• Minor Damage: Superficial issues that do not compromise the functionality or structural integrity of the baggage. This includes light scratches, scuffs, dirt, small dents on hard shells, or broken external pull-zippers where the compartment remains sealed.",
  "• Major Damage: Severe structural failure that compromises the security, containment, or mobility of the baggage. This includes large tears or holes exposing the contents, completely cracked or shattered hard shells, broken wheels/axles preventing rolling, or snapped structural handles.",
  "",
  "Output Format",
  "",
  "Provide your analysis in a clear, scannable format using the following structure:",
  "",
  "🔍 Image Quality Assessment",
  "",
  "[State if the image quality is sufficient. If not, trigger the Error Message from Step 1 and stop.]",
  "",
  "🛡️ Authenticity Verdict",
  "",
  "• Status: [Authenticity Verdict]",
  "• Confidence Score: [0-100%]",
  "• Technical Observations: [Briefly list any anomalies or verification markers found, such as lighting inconsistencies or organic textures.]",
  "",
  "🧳 Damage Assessment Report (Only if Authentic)",
  "",
  "• Classification: [Major Damage / Minor Damage]",
  "• Affected Components: [e.g., Wheels, Main Shell, Zipper, Handle]",
  "• Detailed Findings: [Provide a brief, objective explanation of what visual evidence led to this classification.]",
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

  const images = payload.images || [];
  const content = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.mimeType || "image/jpeg",
      data: image.base64,
    },
  }));
  content.push({
    type: "text",
    text: "Assess this baggage per your instructions.",
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
      max_tokens: 500,
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

  const text = (body.content && body.content[0] && body.content[0].text) || "";
  const result = parseAssessment(text);
  logDamageAssessment(payload, result, text);
  return jsonResponse(result);
}

// Parses the free-text report the system prompt specifies (not JSON) into
// a structured result the frontend can branch on.
function parseAssessment(text) {
  if (/❌/.test(text) || /not clear enough/i.test(text)) {
    const match = text.match(/Error:?\s*([^\n]*)/i);
    return {
      error: (match && match[1].trim()) || "The uploaded photos were not clear enough for assessment.",
    };
  }

  const statusMatch = text.match(/Status:\s*([^\n•]+)/i);
  const authenticity = statusMatch ? statusMatch[1].trim() : "Unknown";

  const confidenceMatch = text.match(/Confidence Score:\s*([^\n•]+)/i);
  const confidence = confidenceMatch ? confidenceMatch[1].trim() : "";

  if (!/^authentic/i.test(authenticity)) {
    return {
      flagged: true,
      authenticity: authenticity,
      confidence: confidence,
    };
  }

  const classificationMatch = text.match(/Classification:\s*([^\n•]+)/i);
  const classificationRaw = classificationMatch ? classificationMatch[1].trim() : "";
  const status = /major/i.test(classificationRaw)
    ? "major"
    : /minor/i.test(classificationRaw)
      ? "minor"
      : null;

  if (!status) {
    return { error: "Could not determine a damage classification from the AI response." };
  }

  return { status: status, authenticity: authenticity, confidence: confidence };
}

function logDamageAssessment(payload, result, rawText) {
  const sheet = getOrCreateDamageLogSheet();
  sheet.appendRow([
    new Date(),
    payload.bookingRef || "",
    payload.bagId || "",
    result.error ? "Error" : result.flagged ? "Flagged" : result.status || "",
    result.authenticity || "",
    result.confidence || "",
    result.error || "",
    rawText,
  ]);
}

function getOrCreateDamageLogSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(DAMAGE_LOG_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DAMAGE_LOG_SHEET);
    sheet.appendRow([
      "Timestamp", "Booking Reference", "Bag ID", "Result",
      "Authenticity Status", "Confidence Score", "Error Message",
      "Full AI Report",
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
