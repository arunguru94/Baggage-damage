import { ChangeEvent, ReactNode, useEffect, useRef, useState } from "react"
import { BarcodeFormat, BrowserMultiFormatReader, DecodeHintType } from "@zxing/library"

const pdf417Hints = new Map()
pdf417Hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417])

const A = "/assets"

// Deployed Google Apps Script Web App URL (see apps-script/Code.gs). Left
// blank, the app falls back to the original demo data so the flow still
// works before the backend is deployed.
const SHEET_API_URL =
  "https://script.google.com/macros/s/AKfycbyGkgj56ggKlnlhj6N4CdX137ovmGeLCtatn62Rh5Nyfq48aqkVdM36Wt6vaZc6DQb_/exec"

type Screen = "home" | "manual" | "details" | "upload" | "analysing" | "analysis-error" | "flagged" | "minor" | "offer" | "accepted" | "receipt" | "transfer" | "success"

type UploadValue = { name: string url: string }
type CompensationType = "money" | "bank"

type TravelerRecord = {
  bookingRef: string
  firstName: string
  lastName: string
  flightNumber: string
  date: string
  from: string
  to: string
  baggageWeightKg: number
  bagCount: number
  seat: string
  mobile: string
  email: string
}

type DamageStatus = "major" | "minor" | "flagged"

type BagClaim = {
  id: string
  images: UploadValue[]
  status: DamageStatus
  outcome: string
  amount: string
}

function nextBagId(bagsSoFar: number) {
  return `BAG${String(bagsSoFar + 1).padStart(2, "0")}`
}

// Parses the mandatory fixed-position fields of an IATA Resolution 792
// "Bar Coded Boarding Pass" (BCBP) string, as encoded in the PDF417 barcode
// printed on a boarding pass. Only the two fields this app needs — passenger
// last name and operating-carrier PNR — are extracted; everything else in
// the barcode is ignored.
function parseBoardingPass(raw: string): { bookingRef: string lastName: string } | undefined {
  if (raw.length < 30 || raw[0] !== "M") return undefined
  const nameField = raw.slice(2, 22).trim()
  const lastName = nameField.split("/")[0]?.trim()
  const bookingRef = raw.slice(23, 30).trim()
  if (!lastName || !bookingRef) return undefined
  return { bookingRef, lastName }
}

function parseAirport(value: string): { city: string code: string } {
  const match = value.match(/^(.*)\(([^)]+)\)\s*$/)
  return match
    ? { city: match[1].trim(), code: match[2].trim() }
    : { city: value, code: "" }
}

function mapTravelerRow(row: Record<string, unknown>): TravelerRecord {
  return {
    bookingRef: String(row["Booking Reference"] ?? ""),
    firstName: String(row["First Name"] ?? ""),
    lastName: String(row["Last Name"] ?? ""),
    flightNumber: String(row["Flight Number"] ?? ""),
    date: String(row["Date"] ?? ""),
    from: String(row["From"] ?? ""),
    to: String(row["To"] ?? ""),
    baggageWeightKg: Number(row["Baggage Weight (kg)"] ?? 0),
    bagCount: Number(row["No of Baggage"] ?? 1),
    seat: String(row["Seat"] ?? ""),
    mobile: String(row["Mobile Number"] ?? ""),
    email: String(row["Email"] ?? ""),
  }
}

async function findTraveler(
  bookingRef: string,
  lastName: string,
): Promise<TravelerRecord | undefined> {
  const url = `${SHEET_API_URL}?bookingRef=${encodeURIComponent(bookingRef)}&lastName=${encodeURIComponent(lastName)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error("Lookup service unavailable")
  const data = await res.json()
  return data.found ? mapTravelerRow(data.record) : undefined
}

async function blobUrlToBase64(url: string): Promise<string> {
  const res = await fetch(url)
  const blob = await res.blob()
  const buffer = await blob.arrayBuffer()
  let binary = ""
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function encodeImages(images: UploadValue[]) {
  return Promise.all(
    images.map(async (image) => ({
      name: image.name,
      mimeType: "image/jpeg",
      base64: await blobUrlToBase64(image.url),
    })),
  )
}

// Real AI damage + authenticity assessment. Images never leave the browser
// unanalysed — this calls the Apps Script backend, which holds the
// Anthropic API key server-side, forwards the images to Claude's vision
// API with the business owner's assessment prompt, and logs every call
// (pass or fail) to the "Baggage damage" sheet tab. Falls back to a
// filename heuristic only when SHEET_API_URL isn't configured yet, so the
// demo keeps working before the backend is deployed.
async function analyseDamage(
  images: UploadValue[],
  bookingRef: string,
  bagId: string,
): Promise<DamageStatus> {
  if (!SHEET_API_URL) {
    const damageImage = images[2]
    return /minor|cosmetic|scratch|small/i.test(damageImage?.name || "")
      ? "minor"
      : "major"
  }
  const encoded = await encodeImages(images)
  const res = await fetch(SHEET_API_URL, {
    method: "POST",
    body: JSON.stringify({ action: "analyse", images: encoded, bookingRef, bagId }),
  })
  if (!res.ok) throw new Error("Analysis service unavailable")
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  if (data.flagged) {
    throw new DamageFlaggedError(data.authenticity || "not verified as authentic")
  }
  if (data.status !== "major" && data.status !== "minor") {
    throw new Error("Analysis service returned an unexpected result")
  }
  return data.status
}

// Distinguishes "the AI couldn't verify this photo is authentic" from a
// generic technical failure, so the UI can show a dedicated review screen
// instead of a plain retry prompt.
class DamageFlaggedError extends Error {
  constructor(public authenticity: string) {
    super(`Image flagged: ${authenticity}`)
  }
}

async function submitClaim(options: {
  traveler?: TravelerRecord
  bags: BagClaim[]
  compensationType: CompensationType
}) {
  if (!SHEET_API_URL || options.bags.length === 0) return
  const bagPayloads = await Promise.all(
    options.bags.map(async (bag) => ({
      bagId: bag.id,
      status: bag.status,
      outcome: bag.outcome,
      amount: bag.amount,
      images: await encodeImages(bag.images),
    })),
  )
  await fetch(SHEET_API_URL, {
    method: "POST",
    body: JSON.stringify({
      bookingRef: options.traveler?.bookingRef ?? "",
      firstName: options.traveler?.firstName ?? "",
      lastName: options.traveler?.lastName ?? "",
      flightNumber: options.traveler?.flightNumber ?? "",
      compensationType: options.compensationType,
      bags: bagPayloads,
    }),
  })
}

// Initial offer: $100 per bag via Etihad Money (instant), $50 per bag via
// bank transfer (up to 30 days). If rejected and a repair receipt is
// uploaded, the final settlement rises to $150 via Etihad Money or $100 via
// bank transfer.
const compensationDetails = {
  money: {
    label: "Etihad Money",
    totalLabel: "Etihad Money (instant credit)",
    amount: "$100.00",
  },
  bank: {
    label: "Bank transfer",
    totalLabel: "Bank transfer (up to 30 days)",
    amount: "$50.00",
  },
} satisfies Record<CompensationType, {
  label: string
  totalLabel: string
  amount: string
}>

const postReceiptDetails = {
  money: {
    label: "Etihad Money",
    totalLabel: "Etihad Money",
    amount: "$150.00",
  },
  bank: {
    label: "Bank transfer",
    totalLabel: "Bank transfer",
    amount: "$100.00",
  },
} satisfies Record<CompensationType, {
  label: string
  totalLabel: string
  amount: string
}>

const icons = {
  back: "61afd.svg",
  upload: "70a40.svg",
  info: "a0354.svg",
  documents: "4fb95.svg",
  close: "46301.svg",
  plusCircle: "875ff.svg",
  checkedBaggage: "7342f.svg",
  check: "ab182.svg",
  delete: "2644e.svg",
  plus: "30959.svg",
} as const

function DesignIcon({
  name,
  className = "",
}: {
  name: keyof typeof icons
  className?: string
}) {
  return (
    <img
      className={`design-icon ${className}`}
      src={`${A}/${icons[name]}`}
      alt=""
      aria-hidden="true"
    />
  )
}

function BlueUploadIcon({ className = "" }: { className?: string }) {
  return <span className={`blue-upload-icon ${className}`} aria-hidden="true" />
}

function Header() {
  return (
    <header className="app-header">
      <img
        className="brand-logo"
        src={`${A}/43ce7.svg`}
        alt="Etihad Airways — Beyond Borders"
      />
    </header>
  )
}

function Shell({
  children,
  back,
  className = "",
}: {
  children: ReactNode
  back?: () => void
  className?: string
}) {
  return (
    <div className={`screen ${className}`}>
      <Header />
      <main className="page">
        {back && (
          <button className="back" onClick={back} type="button">
            <DesignIcon name="back" /> Back
          </button>
        )}
        {children}
      </main>
    </div>
  )
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  outline = false,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  outline?: boolean
}) {
  return (
    <button
      className={`primary-button ${outline ? "outline" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function Home({ scan, manual }: { scan: () => void manual: () => void }) {
  return (
    <div className="home">
      <Header />
      <div className="home-panel">
        <div className="home-title">
          <h1>Scan your boarding pass</h1>
          <p>Start your instant baggage claim.</p>
        </div>
        <div className="feature-grid">
          <div className="feature-card">
            <img src={`${A}/ef3f3.svg`} alt="" />
            <strong>Check your Boarding Pass</strong>
            <span>The barcode must be clearly visible without damage.</span>
          </div>
          <div className="feature-card">
            <img src={`${A}/c50ca.svg`} alt="" />
            <strong>Scan Boarding Pass</strong>
            <span>Use your phone to scan your boarding pass.</span>
          </div>
        </div>
        <div className="feature-card instant">
          <img src={`${A}/c97c4.svg`} alt="" />
          <div>
            <strong>Claim instantly</strong>
            <span>
              If you’re eligible, you’ll receive compensation instantly.
            </span>
          </div>
        </div>
        <PrimaryButton onClick={scan}>Scan now</PrimaryButton>
        <PrimaryButton onClick={manual} outline>
          Enter Manually
        </PrimaryButton>
      </div>
    </div>
  )
}

function ScanModal({
  onScanned,
  cancel,
  manualFallback,
}: {
  onScanned: (bookingRef: string, lastName: string) => Promise<boolean>
  cancel: () => void
  manualFallback: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // App.tsx passes a fresh inline function on every render; keeping it in a
  // ref (instead of the effect's dependency array) stops the camera from
  // being torn down and reacquired whenever the parent re-renders mid-scan.
  const onScannedRef = useRef(onScanned)
  onScannedRef.current = onScanned
  const [status, setStatus] = useState<"scanning" | "checking" | "error" | "notfound">(
    "scanning",
  )
  const [message, setMessage] = useState("")

  useEffect(() => {
    const reader = new BrowserMultiFormatReader(pdf417Hints)
    let active = true

    reader
      .decodeOnceFromVideoDevice(undefined, videoRef.current ?? undefined)
      .then(async (result) => {
        if (!active) return
        const parsed = parseBoardingPass(result.getText())
        if (!parsed) {
          setStatus("error")
          setMessage(
            "Couldn’t read that barcode clearly. Hold the boarding pass flatter and steadier, or enter your details manually.",
          )
          return
        }
        setStatus("checking")
        const found = await onScannedRef.current(parsed.bookingRef, parsed.lastName)
        if (!active) return
        if (!found) {
          setStatus("notfound")
          setMessage("We couldn’t find a booking that matches this boarding pass.")
        }
      })
      .catch((err) => {
        if (!active) return
        setStatus("error")
        setMessage(
          err?.name === "NotAllowedError"
            ? "Camera access was denied. Enter your details manually instead."
            : "Couldn’t access the camera on this device. Enter your details manually instead.",
        )
      })

    return () => {
      active = false
      reader.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-layer">
      <div
        className="scan-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Scan boarding pass"
      >
        <button
          className="close"
          onClick={cancel}
          aria-label="Close"
          type="button"
        >
          <DesignIcon name="close" />
        </button>
        <h2>Scan boarding pass</h2>
        <p>Point your camera at the barcode on your boarding pass.</p>
        <div className="scanner">
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          <video ref={videoRef} className="scanner-video" muted playsInline aria-hidden="true" />
          {status === "scanning" && <span className="laser" />}
        </div>
        {status === "error" || status === "notfound" ? (
          <p role="alert" className="field-error">
            {message}
          </p>
        ) : (
          <div className="scan-status" role="status" aria-live="polite">
            <strong>{status === "checking" ? "Checking your booking …" : "Scanning ..."}</strong>
            <p>Hold your camera still</p>
          </div>
        )}
        <button className="scan-manual-link" onClick={manualFallback} type="button">
          Enter details manually instead
        </button>
      </div>
    </div>
  )
}

function Manual({
  back,
  search,
}: {
  back: () => void
  search: (bookingRef: string, lastName: string) => Promise<boolean>
}) {
  const [booking, setBooking] = useState("")
  const [lastName, setLastName] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
  const bookingRef = useRef<HTMLInputElement>(null)

  async function submit() {
    if (status === "loading") return
    setStatus("loading")
    try {
      const found = await search(booking.trim(), lastName.trim())
      if (!found) {
        setStatus("error")
        bookingRef.current?.focus()
      }
    } catch {
      setStatus("error")
      bookingRef.current?.focus()
    }
  }

  return (
    <Shell back={back}>
      <section className="manual-content">
        <h1>Enter your booking details</h1>
        <div className="input-card">
          <input
            ref={bookingRef}
            value={booking}
            onChange={(e) => setBooking(e.target.value)}
            placeholder="Booking reference or ticket number"
            aria-label="Booking reference or ticket number"
            aria-invalid={status === "error"}
            aria-describedby={status === "error" ? "manual-search-error" : undefined}
          />
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            aria-label="Last name"
            aria-invalid={status === "error"}
            aria-describedby={status === "error" ? "manual-search-error" : undefined}
          />
        </div>
        {status === "error" && (
          <p id="manual-search-error" className="field-error" role="alert">
            We couldn’t find a booking with that reference and last name.
            Check the details and try again.
          </p>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {status === "loading" ? "Checking booking details…" : ""}
        </span>
        <PrimaryButton
          onClick={submit}
          disabled={!booking.trim() || !lastName.trim()}
        >
          {status === "loading" ? "Checking…" : "Continue"}
        </PrimaryButton>
      </section>
    </Shell>
  )
}

function FlightCard({ traveler }: { traveler?: TravelerRecord }) {
  const from = traveler ? parseAirport(traveler.from) : { city: "Abu Dhabi", code: "AUH" }
  const to = traveler ? parseAirport(traveler.to) : { city: "Bangkok", code: "BKK" }
  return (
    <div className="flight-card">
      <div className="flight-top">
        <span className="flight-mark">
          <img src={`${A}/c1cb7.svg`} alt="" />
        </span>
        <span>{traveler?.bookingRef || "N7OBUF"}</span>
        <span className="flight-check">
          <DesignIcon name="check" />
        </span>
      </div>
      <div className="route">
        <div>
          <small>{from.city}</small>
          <strong>{from.code}</strong>
          <small>{traveler?.date || "12 Oct"}</small>
        </div>
        <div className="route-direction" aria-label="One way flight">
          <img src={`${A}/8b2e0.svg`} alt="" />
          <span>
            <img src={`${A}/3683b.svg`} alt="" />
            One way
          </span>
          <img src={`${A}/23863.svg`} alt="" />
        </div>
        <div className="right">
          <small>{to.city}</small>
          <strong>{to.code}</strong>
          <small>{traveler?.date || "19 Oct"}</small>
        </div>
      </div>
    </div>
  )
}

function Details({
  back,
  next,
  traveler,
}: {
  back: () => void
  next: () => void
  traveler?: TravelerRecord
}) {
  const [reported, setReported] = useState(false)
  const [pir, setPir] = useState("")
  const [pirNumbers, setPirNumbers] = useState<string[]>([])
  const [lastName, setLastName] = useState(traveler?.lastName || "Al Kamali")
  const [mobile, setMobile] = useState(traveler?.mobile || "053 646 5254")

  function addPir() {
    const value = pir.trim().toUpperCase()
    if (!value || pirNumbers.includes(value)) return
    setPirNumbers((current) => [...current, value])
    setPir("")
  }

  function removePir(value: string) {
    setPirNumbers((current) => current.filter((item) => item !== value))
  }

  return (
    <Shell back={back}>
      <div className="details-well">
        <FlightCard traveler={traveler} />
        <section className="card passenger">
          <h2>Passengers</h2>
          <div>
            <strong>
              {traveler
                ? `${traveler.firstName} ${traveler.lastName}`
                : "Ahmed Mohammed Al Kamali"}
            </strong>
            <strong>{traveler?.seat || "12A"}</strong>
          </div>
          <span className="badge">Adult</span>
        </section>
        {traveler && (
          <section className="card baggage-info">
            <h2>Baggage on this booking</h2>
            <div className="baggage-info-row">
              <DesignIcon name="checkedBaggage" />
              <div>
                <strong>
                  {traveler.bagCount} {traveler.bagCount === 1 ? "bag" : "bags"}
                </strong>
                <span>{traveler.baggageWeightKg} kg total</span>
              </div>
            </div>
          </section>
        )}
        <section className="card">
          <h2>Did you report your damaged baggage at the airport?</h2>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                checked={reported}
                onChange={() => setReported(true)}
              />{" "}
              Yes
            </label>
            <label>
              <input
                type="radio"
                checked={!reported}
                onChange={() => setReported(false)}
              />{" "}
              No
            </label>
          </div>
          {reported && (
            <div className="pir-entry">
              <label htmlFor="pir">
                Property Irregularity Report (PIR) number*
              </label>
              <input
                id="pir"
                value={pir}
                onChange={(e) => setPir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addPir()
                  }
                }}
                placeholder="e.g. AUHEY12345"
              />
              {pirNumbers.length > 0 && (
                <div className="pir-list" aria-label="Saved PIR numbers">
                  {pirNumbers.map((value) => (
                    <div className="pir-item" key={value}>
                      <div>
                        <span>PIR number</span>
                        <strong>{value}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePir(value)}
                        aria-label={`Delete PIR ${value}`}
                      >
                        <DesignIcon name="delete" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                className="add-pir"
                type="button"
                onClick={addPir}
                disabled={!pir.trim()}
              >
                <DesignIcon name="plusCircle" />
                Add additional PIR
              </button>
            </div>
          )}
        </section>
        <section className="card contact-card">
          <h2>Contact information</h2>
          <p>We’ll use these details to keep you updated about your flight</p>
          <label>
            <span>Last name*</span>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
          <label>
            <span>Select country code</span>
            <select defaultValue="+971">
              <option>+971</option>
              <option>+44</option>
              <option>+1</option>
            </select>
          </label>
          <label>
            <span>Mobile number*</span>
            <input
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              inputMode="tel"
            />
          </label>
        </section>
      </div>
      <div className="bottom-action">
        <PrimaryButton
          onClick={next}
          disabled={reported && pirNumbers.length === 0}
        >
          Continue
        </PrimaryButton>
      </div>
    </Shell>
  )
}

const uploadSteps = [
  {
    title: "Baggage Tag",
    copy: "Please ensure the baggage tag stays attached to the bag",
    example: "8537d.png",
  },
  {
    title: "Brand Label",
    copy: "Take a close photo of the luggage brand logo or label.",
    example: "bba0d.png",
  },
  {
    title: "Close-up of Damage",
    copy: "Take a close-up photo of the damaged area.",
    example: "9fcd4.png",
  },
]

function ImagePicker({
  value,
  onChange,
  index,
  additional = false,
}: {
  value?: UploadValue
  onChange: (value: UploadValue) => void
  index: number
  additional?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) onChange({ name: file.name, url: URL.createObjectURL(file) })
  }
  return (
    <button
      className={`image-picker ${value ? "has-image" : ""}`}
      onClick={() => ref.current?.click()}
      type="button"
    >
      {value ? (
        <>
          <img src={value.url} alt={`Uploaded ${uploadSteps[index].title}`} />
          <span className="remove-badge">
            <DesignIcon name="close" />
          </span>
        </>
      ) : (
        <>
          {additional ? (
            <DesignIcon name="plus" className="plus-icon" />
          ) : (
            <BlueUploadIcon className="upload-icon" />
          )}
          <strong>Click to upload</strong>
          <small>or drag and drop JPG, PNG up to 10MB</small>
        </>
      )}
      <input
        ref={ref}
        hidden
        type="file"
        accept="image/png,image/jpeg"
        onChange={choose}
      />
    </button>
  )
}

function UploadEvidence({
  bagId,
  back,
  analyse,
}: {
  bagId: string
  back: () => void
  analyse: (images: UploadValue[]) => void
}) {
  const [uploads, setUploads] = useState<(UploadValue | undefined)[]>([])
  const [extra, setExtra] = useState<UploadValue>()
  return (
    <Shell back={back}>
      <section className="upload-card">
        <div className="upload-heading">
          <h1>Baggage Damage Details</h1>
          <span>
            <DesignIcon name="checkedBaggage" /> {bagId}
          </span>
        </div>
        <p className="required-label">Upload Required Images</p>
        <div className="images-only">
          <span className="radio-dot" /> Images
        </div>
        <hr />
        <h2>Upload Required Images</h2>
        <p className="helper">
          Please follow the instructions and examples for each required photo.
        </p>
        <div className="steps">
          {uploadSteps.map((step, index) => (
            <article className="upload-step" key={step.title}>
              <h3>
                <span>{index + 1}</span> {step.title}
                <b>*</b> <DesignIcon name="info" className="step-info" />
              </h3>
              <p>{step.copy}</p>
              <div className="upload-compare">
                <ImagePicker
                  index={index}
                  value={uploads[index]}
                  onChange={(value) =>
                    setUploads((current) => {
                      const next = [...current]
                      next[index] = value
                      return next
                    })
                  }
                />
                <div className="example">
                  <small>Example</small>
                  <img
                    src={`${A}/${step.example}`}
                    alt={`Example ${step.title}`}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
        <h3 className="additional-title">
          Additional Photos <span>(Optional)</span>
          <DesignIcon name="plusCircle" />
        </h3>
        <div className="additional-row">
          <ImagePicker index={0} value={extra} onChange={setExtra} additional />
        </div>
        <PrimaryButton
          disabled={uploads.filter(Boolean).length !== 3}
          onClick={() => {
            const allImages = [...uploads, extra].filter(
              (value): value is UploadValue => Boolean(value),
            )
            analyse(allImages)
          }}
        >
          Analyse
        </PrimaryButton>
      </section>
    </Shell>
  )
}

function Analysing({
  images,
  bookingRef,
  bagId,
  onResult,
  onError,
  onFlagged,
}: {
  images: UploadValue[]
  bookingRef: string
  bagId: string
  onResult: (status: DamageStatus) => void
  onError: (message?: string) => void
  onFlagged: (authenticity: string) => void
}) {
  useEffect(() => {
    let cancelled = false
    const minDelay = new Promise<void>((resolve) => window.setTimeout(resolve, 1800))
    Promise.all([analyseDamage(images, bookingRef, bagId), minDelay])
      .then(([status]) => {
        if (!cancelled) onResult(status)
      })
      .catch((err) => {
        if (cancelled) return
        // A failed/unreachable analysis is never disguised as a real
        // "minor damage" verdict — that would wrongly deny a real claim.
        if (err instanceof DamageFlaggedError) {
          onFlagged(err.authenticity)
        } else {
          onError(err instanceof Error ? err.message : undefined)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Shell className="analysis-bg">
      <div className="analysis-overlay">
        <div className="analysis-modal">
          <div className="analysis-logo">
            <img src={`${A}/c1cb7.svg`} alt="" />
          </div>
          <h1>
            Analysing <span className="dots">...</span>
          </h1>
          <p>We’re checking your bag.</p>
        </div>
      </div>
    </Shell>
  )
}

function AnalysisError({
  message,
  retry,
  back,
}: {
  message?: string
  retry: () => void
  back: () => void
}) {
  return (
    <Shell back={back}>
      <section className="minor-heading">
        <h1>We couldn’t analyse your photos</h1>
      </section>
      <section className="minor-card">
        <div className="minor-copy">
          <p role="alert">
            {message ||
              "Something went wrong while reviewing your baggage damage photos. This is a technical issue, not a decision about your claim — please try again."}
          </p>
        </div>
      </section>
      <div className="minor-actions">
        <button className="line-pill" onClick={back} type="button">
          Re-upload photos
        </button>
        <button className="gold-pill" onClick={retry} type="button">
          Try again
        </button>
      </div>
    </Shell>
  )
}

function FlaggedForReview({
  bagId,
  authenticity,
  back,
  retry,
  close,
}: {
  bagId: string
  authenticity: string
  back: () => void
  retry: () => void
  close: () => void
}) {
  return (
    <Shell back={back}>
      <section className="minor-heading">
        <h1>Manage baggage concern</h1>
      </section>
      <section className="minor-card">
        <div className="minor-assessment">
          <span>Damage assessment result</span>
          <strong>Referred for manual review</strong>
        </div>
        <div className="minor-copy">
          <p role="alert">
            We couldn’t verify {bagId}’s photos as an authentic, unedited
            capture ({authenticity}). We haven’t denied your claim — it’s
            been flagged for a team member to review by hand. If this looks
            wrong, try retaking the photos in good lighting without any
            editing or filters.
          </p>
        </div>
      </section>
      <div className="minor-actions">
        <button className="line-pill" onClick={retry} type="button">
          Retry
        </button>
        <button className="gold-pill" onClick={close} type="button">
          Close
        </button>
      </div>
    </Shell>
  )
}

function MinorDamage({
  bagId,
  bagImage,
  traveler,
  back,
  retry,
  close,
  addAnotherBag,
}: {
  bagId: string
  bagImage?: UploadValue
  traveler?: TravelerRecord
  back: () => void
  retry: () => void
  close: () => void
  addAnotherBag: () => void
}) {
  return (
    <Shell back={back}>
      <section className="minor-heading">
        <h1>Manage baggage concern</h1>
        <p>
          Trip reference: <strong>{traveler?.bookingRef || "8LOJ4F"}</strong>
        </p>
      </section>
      <section className="minor-card">
        <div className="bag-row">
          <img
            src={bagImage?.url || `${A}/a9f54.png`}
            alt={bagImage ? "Uploaded baggage brand label" : "Brown suitcase"}
          />
          <div>
            <strong>{bagId}</strong>
            <span>EY678764</span>
          </div>
        </div>
        <div className="minor-assessment">
          <span>Damage assessment result</span>
          <strong>Not eligible for compensation</strong>
        </div>
        <div className="minor-copy">
          <p>
            We’re sorry your baggage was damaged during your journey with us.
            Based on our assessment, the damage appears to be cosmetic, and your
            bag is still suitable for travel.
          </p>
          <p>
            Although cosmetic damage isn't eligible for compensation, we've
            recorded your feedback to help us improve how baggage is handled.
          </p>
        </div>
      </section>
      <div className="minor-actions">
        <button className="line-pill" onClick={retry} type="button">
          Retry
        </button>
        <button className="gold-pill" onClick={close} type="button">
          Close
        </button>
      </div>
      <button className="add-bag-button" onClick={addAnotherBag} type="button">
        <DesignIcon name="plusCircle" />
        Add another bag
      </button>
    </Shell>
  )
}

function CompensationTabs({
  value,
  onChange,
}: {
  value: CompensationType
  onChange: (value: CompensationType) => void
}) {
  return (
    <div className="tabs">
      <button
        className={value === "money" ? "active" : ""}
        onClick={() => onChange("money")}
        type="button"
      >
        Etihad Money (instant credit)
      </button>
      <button
        className={value === "bank" ? "active" : ""}
        onClick={() => onChange("bank")}
        type="button"
      >
        Bank transfer (up to 30 days)
      </button>
    </div>
  )
}

function BagSummary({
  bagId,
  bagImage,
}: {
  bagId: string
  bagImage?: UploadValue
}) {
  return (
    <>
      <div className="bag-row">
        <img
          src={bagImage?.url || `${A}/a9f54.png`}
          alt={
            bagImage ? "Uploaded baggage brand label" : "Damaged brown suitcase"
          }
        />
        <div>
          <strong>{bagId}</strong>
          <span>EY678764</span>
        </div>
      </div>
      <div className="assessment">
        <span>Damage assessment result</span>
        <strong>Eligible for compensation</strong>
      </div>
    </>
  )
}

function Offer({
  bagId,
  back,
  reject,
  accept,
  type,
  onTypeChange,
  bagImage,
  traveler,
  locked,
}: {
  bagId: string
  back: () => void
  reject: () => void
  accept: () => void
  type: CompensationType
  onTypeChange: (type: CompensationType) => void
  bagImage?: UploadValue
  traveler?: TravelerRecord
  locked: boolean
}) {
  const details = compensationDetails[type]
  return (
    <Shell back={back}>
      <section className="offer-header">
        <h1>Manage baggage concern</h1>
        <p>
          Trip reference: <strong>{traveler?.bookingRef || "8LOJ4F"}</strong>
        </p>
        <CompensationTabs value={type} onChange={onTypeChange} />
      </section>
      <section className="offer-card">
        <BagSummary bagId={bagId} bagImage={bagImage} />
        <div className="offer-value">
          <h2>Eligible offer</h2>
          <div>
            <span>{details.label}</span>
            <strong>{details.amount}</strong>
          </div>
        </div>
        <h2>Please select</h2>
        {locked ? (
          <p className="field-error" role="alert">
            This bag’s decision has already been saved. Go back to add a new
            bag, or continue from where you left off.
          </p>
        ) : (
          <div className="offer-actions">
            <button className="gold-pill" onClick={accept} type="button">
              Accept Offer
            </button>
            <button className="line-pill" onClick={reject} type="button">
              Reject &amp; upload Receipt
            </button>
          </div>
        )}
      </section>
      <Total type={type} />
    </Shell>
  )
}

function Total({
  type,
  postReceipt = false,
}: {
  type: CompensationType
  postReceipt?: boolean
}) {
  const details = postReceipt
    ? postReceiptDetails[type]
    : compensationDetails[type]
  return (
    <section className="total-card">
      <h2>Total amount</h2>
      <div>
        <span>{details.totalLabel}</span>
        <strong>{details.amount}</strong>
      </div>
    </section>
  )
}

function ManageActions({
  addBag,
  addDisabled = false,
  addDisabledHint,
  continueFlow,
  continueDisabled = false,
}: {
  addBag: () => void
  addDisabled?: boolean
  addDisabledHint?: string
  continueFlow?: () => void
  continueDisabled?: boolean
}) {
  return (
    <div className="manage-actions">
      <button
        className="add-bag-button"
        onClick={addBag}
        disabled={addDisabled}
        aria-describedby={addDisabled && addDisabledHint ? "add-bag-hint" : undefined}
        type="button"
      >
        <DesignIcon name="plusCircle" />
        Add another bag
      </button>
      {addDisabled && addDisabledHint && (
        <p id="add-bag-hint" className="field-error">
          {addDisabledHint}
        </p>
      )}
      <PrimaryButton
        onClick={continueFlow}
        disabled={continueDisabled || !continueFlow}
      >
        Continue
      </PrimaryButton>
    </div>
  )
}

function Accepted({
  bagId,
  back,
  type,
  onTypeChange,
  bagImage,
  traveler,
  addBag,
  continueFlow,
}: {
  bagId: string
  back: () => void
  type: CompensationType
  onTypeChange: (type: CompensationType) => void
  bagImage?: UploadValue
  traveler?: TravelerRecord
  addBag: () => void
  continueFlow: () => void
}) {
  return (
    <Shell back={back}>
      <section className="offer-header">
        <h1>Manage baggage concern</h1>
        <p>
          Trip reference: <strong>{traveler?.bookingRef || "8LOJ4F"}</strong>
        </p>
        <CompensationTabs value={type} onChange={onTypeChange} />
      </section>
      <section className="offer-card">
        <BagSummary bagId={bagId} bagImage={bagImage} />
        <div className="offer-value">
          <h2>Eligible offer</h2>
          <div>
            <span>{compensationDetails[type].label}</span>
            <strong>{compensationDetails[type].amount}</strong>
          </div>
        </div>
        <h2>Selection</h2>
        <p className="accepted-copy">
          Offer accepted. Your compensation is being arranged.
        </p>
      </section>
      <Total type={type} />
      <ManageActions addBag={addBag} continueFlow={continueFlow} />
    </Shell>
  )
}

function Receipt({
  bagId,
  back,
  type,
  onTypeChange,
  bagImage,
  traveler,
  locked,
  onAddAnotherBag,
  onContinueToTransfer,
}: {
  bagId: string
  back: () => void
  type: CompensationType
  onTypeChange: (type: CompensationType) => void
  bagImage?: UploadValue
  traveler?: TravelerRecord
  locked: boolean
  onAddAnotherBag: () => void
  onContinueToTransfer: () => void
}) {
  const [file, setFile] = useState<File>()
  const [confirming, setConfirming] = useState<"add" | "continue" | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const details = file ? postReceiptDetails[type] : compensationDetails[type]
  return (
    <Shell back={back}>
      <section className="offer-header">
        <h1>Manage baggage concern</h1>
        <p>
          Trip reference: <strong>{traveler?.bookingRef || "8LOJ4F"}</strong>
        </p>
        <CompensationTabs value={type} onChange={onTypeChange} />
      </section>
      <section className="offer-card receipt-summary">
        <BagSummary bagId={bagId} bagImage={bagImage} />
        <div className="offer-value">
          <h2>Eligible offer</h2>
          <div>
            <span>{details.label}</span>
            <strong>{details.amount}</strong>
          </div>
        </div>
        <h2>Selection</h2>
        <p>Rejected</p>
      </section>
      {locked ? (
        <section className="receipt-card">
          <p className="field-error" role="alert">
            This bag’s receipt has already been submitted. Go back to add a
            new bag, or continue from where you left off.
          </p>
        </section>
      ) : (
        <>
          <section className="receipt-card">
            <p>
              <DesignIcon name="info" className="info-icon" /> So that we can
              review your claim, please upload a receipt or invoice from an
              authorised repair service.
            </p>
            <h3>Do you have a receipt or invoice?</h3>
            <button
              className={`receipt-upload ${file ? "uploaded" : ""}`}
              onClick={() => ref.current?.click()}
              type="button"
            >
              {file ? (
                <>
                  <DesignIcon name="documents" />
                  <div>
                    <strong>{file.name}</strong>
                    <small>{Math.max(1, Math.round(file.size / 1024))}kb</small>
                  </div>
                </>
              ) : (
                <>
                  <BlueUploadIcon />
                  <div>
                    <strong>
                      Click to upload <em>or drag and drop</em>
                    </strong>
                    <small>SVG, PNG or JPG (max. 800×400px)</small>
                  </div>
                </>
              )}
              <input
                ref={ref}
                hidden
                type="file"
                accept=".pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </button>
          </section>
          <Total type={type} postReceipt={Boolean(file)} />
          <ManageActions
            addBag={() => setConfirming("add")}
            addDisabled={!file}
            addDisabledHint={!file ? "Upload a repair receipt before adding another bag." : undefined}
            continueFlow={() => setConfirming("continue")}
            continueDisabled={!file}
          />
        </>
      )}
      {confirming && (
        <ConfirmationDialog
          cancel={() => setConfirming(null)}
          confirm={() => {
            if (confirming === "add") onAddAnotherBag()
            else onContinueToTransfer()
            setConfirming(null)
          }}
        />
      )}
    </Shell>
  )
}

function ConfirmationDialog({
  cancel,
  confirm,
}: {
  cancel: () => void
  confirm: () => void
}) {
  return (
    <div className="confirmation-layer" role="presentation">
      <div
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <h2 id="confirmation-title">Submit claim</h2>
        <p>Are you sure you want to submit your claim?</p>
        <div>
          <button className="line-pill" onClick={cancel} type="button">
            No
          </button>
          <button className="gold-pill" onClick={confirm} type="button">
            Yes
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
}) {
  return (
    <label className="transfer-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function PaymentSummary({ type }: { type: CompensationType }) {
  const details = postReceiptDetails[type]
  return (
    <div className="payment-summary">
      <span className="payment-check">
        <DesignIcon name="check" />
      </span>
      <div>
        <strong>{details.label}</strong>
        <span>{details.amount.replace("$", "")} USD</span>
      </div>
    </div>
  )
}

function TransferDetails({
  type,
  traveler,
  back,
  submit,
}: {
  type: CompensationType
  traveler?: TravelerRecord
  back: () => void
  submit: () => void
}) {
  const [firstName, setFirstName] = useState(traveler?.firstName || "Waqar")
  const [lastName, setLastName] = useState(traveler?.lastName || "Sohail")
  const [email, setEmail] = useState(traveler?.email || "waqarsohail@etihad.ae")
  const [confirmEmail, setConfirmEmail] = useState(
    traveler?.email || "waqarsohail@etihad.ae",
  )
  const [acceptedTerms, setAcceptedTerms] = useState(true)
  const [currency, setCurrency] = useState("USD")
  const [city, setCity] = useState("Mumbai")
  const [bankName, setBankName] = useState("Bank of Baroda")
  const [swift, setSwift] = useState("BOBXXXXXX")
  const [localSwift, setLocalSwift] = useState("XXXXXXXX")
  const [route, setRoute] = useState("XXXXXXXX")
  const [localRoute, setLocalRoute] = useState("XXXXXXXX")

  const moneyValid =
    firstName.trim() &&
    lastName.trim() &&
    email.trim() &&
    email === confirmEmail &&
    acceptedTerms
  const bankValid = [
    currency,
    city,
    bankName,
    swift,
    localSwift,
    route,
    localRoute,
  ].every((value) => value.trim())

  return (
    <Shell back={back}>
      <section className="transfer-heading">
        <h1>Damage assessment result</h1>
        <p>
          Trip reference: <strong>{traveler?.bookingRef || "8LOJ4F"}</strong>
        </p>
      </section>
      <section className="transfer-card">
        <div className="transfer-section">
          <h2>Payment information</h2>
          <PaymentSummary type={type} />
        </div>
        {type === "money" ? (
          <>
            <div className="transfer-section">
              <h2>Etihad Money</h2>
              <div className="transfer-fields">
                <Field
                  label="First name *"
                  value={firstName}
                  onChange={setFirstName}
                />
                <Field
                  label="Last name *"
                  value={lastName}
                  onChange={setLastName}
                />
                <Field
                  label="Email *"
                  value={email}
                  onChange={setEmail}
                  type="email"
                />
                <Field
                  label="Confirm email *"
                  value={confirmEmail}
                  onChange={setConfirmEmail}
                  type="email"
                />
              </div>
            </div>
            <div className="transfer-section">
              <h2>Baggage terms and conditions</h2>
              <label className="terms">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                />
                <span>
                  I accept this payment as full and final settlement of all
                  claims relating to the mishandling of my baggage. I agree to
                  indemnify Etihad Airways, its servants, agents and insurers
                  from and against all further claims made in respect of said
                  loss and/or damage.
                </span>
              </label>
            </div>
            <div className="signature-section">
              <h2>Signature</h2>
              <div className="signature-box">
                <img src={`${A}/8abdc.png`} alt="Customer signature" />
              </div>
              <button type="button">Clear Signature</button>
              <p>
                {firstName} {lastName}
              </p>
            </div>
            <PrimaryButton onClick={submit} disabled={!moneyValid}>
              Proceed
            </PrimaryButton>
          </>
        ) : (
          <>
            <div className="transfer-section">
              <h2>Fill in the details</h2>
              <div className="transfer-fields bank-fields">
                <Field
                  label="Currency*"
                  value={currency}
                  onChange={setCurrency}
                />
                <Field label="City" value={city} onChange={setCity} />
                <Field
                  label="Bank name*"
                  value={bankName}
                  onChange={setBankName}
                />
                <Field label="Swift code*" value={swift} onChange={setSwift} />
                <Field
                  label="Swift code (in local language)*"
                  value={localSwift}
                  onChange={setLocalSwift}
                />
                <Field label="Route*" value={route} onChange={setRoute} />
                <Field
                  label="Route (in local language)*"
                  value={localRoute}
                  onChange={setLocalRoute}
                />
              </div>
            </div>
            <PrimaryButton onClick={submit} disabled={!bankValid}>
              Continue
            </PrimaryButton>
          </>
        )}
      </section>
    </Shell>
  )
}

function Success({ type }: { type: CompensationType }) {
  return (
    <Shell className="success-screen">
      <section className="success-card">
        <img src={`${A}/897c9.svg`} alt="" />
        <h1>Thank you!</h1>
        <p>
          {type === "money"
            ? "Etihad Money will be sent to your registered email address."
            : "Your bank transfer will be processed using the details provided."}
        </p>
        <p>
          Your reference number is: <strong>2323232323</strong>
        </p>
      </section>
    </Shell>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home")
  const [scanning, setScanning] = useState(false)
  const [compensation, setCompensation] = useState<CompensationType>("money")
  const [bagImage, setBagImage] = useState<UploadValue>()
  const [uploadedImages, setUploadedImages] = useState<UploadValue[]>([])
  const [traveler, setTraveler] = useState<TravelerRecord>()
  const [bags, setBags] = useState<BagClaim[]>([])
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string>()
  const [flaggedAuthenticity, setFlaggedAuthenticity] = useState("")

  const activeBagId = nextBagId(bags.length)

  async function handleSearch(bookingRef: string, lastName: string) {
    if (!SHEET_API_URL) {
      // No Apps Script URL configured yet — keep the original demo flow working.
      setScreen("details")
      return true
    }
    const found = await findTraveler(bookingRef, lastName)
    if (!found) return false
    setTraveler(found)
    setScreen("details")
    return true
  }

  // Locks in the bag currently being processed (its images + outcome) and
  // clears the per-bag staging state so the next bag starts fresh. Returns
  // the full accumulated list so callers can submit it immediately without
  // waiting on React's async state update.
  function finalizeActiveBag(status: DamageStatus, outcome: string, amount: string) {
    const bag: BagClaim = { id: activeBagId, images: uploadedImages, status, outcome, amount }
    const next = [...bags, bag]
    setBags(next)
    setUploadedImages([])
    setBagImage(undefined)
    return next
  }

  function startNextBag() {
    setScreen("upload")
  }

  function finishSession(finalBags: BagClaim[]) {
    submitClaim({ traveler, bags: finalBags, compensationType: compensation }).catch(() => {
      // Best-effort: the claim still proceeds in the UI even if the sheet write fails.
    })
    setBags([])
    setTraveler(undefined)
  }

  return (
    <>
      {screen === "home" && (
        <Home
          scan={() => setScanning(true)}
          manual={() => setScreen("manual")}
        />
      )}
      {screen === "manual" && (
        <Manual back={() => setScreen("home")} search={handleSearch} />
      )}
      {screen === "details" && (
        <Details
          back={() => setScreen("home")}
          next={() => setScreen("upload")}
          traveler={traveler}
        />
      )}
      {screen === "upload" && (
        <UploadEvidence
          bagId={activeBagId}
          back={() => setScreen("details")}
          analyse={(images) => {
            setUploadedImages(images)
            setBagImage(images[1] ?? images[0])
            setScreen("analysing")
          }}
        />
      )}
      {screen === "analysing" && (
        <Analysing
          images={uploadedImages}
          bookingRef={traveler?.bookingRef ?? ""}
          bagId={activeBagId}
          onResult={(status) => setScreen(status === "minor" ? "minor" : "offer")}
          onError={(message) => {
            setAnalysisErrorMessage(message)
            setScreen("analysis-error")
          }}
          onFlagged={(authenticity) => {
            setFlaggedAuthenticity(authenticity)
            setScreen("flagged")
          }}
        />
      )}
      {screen === "analysis-error" && (
        <AnalysisError
          message={analysisErrorMessage}
          retry={() => setScreen("analysing")}
          back={() => setScreen("upload")}
        />
      )}
      {screen === "flagged" && (
        <FlaggedForReview
          bagId={activeBagId}
          authenticity={flaggedAuthenticity}
          back={() => setScreen("upload")}
          retry={() => setScreen("upload")}
          close={() => {
            const finalBags = finalizeActiveBag(
              "flagged",
              `Flagged for manual review — ${flaggedAuthenticity}`,
              "$0.00",
            )
            finishSession(finalBags)
            setScreen("home")
          }}
        />
      )}
      {screen === "minor" && (
        <MinorDamage
          bagId={activeBagId}
          bagImage={bagImage}
          traveler={traveler}
          back={() => setScreen("upload")}
          retry={() => setScreen("upload")}
          close={() => {
            const finalBags = finalizeActiveBag("minor", "Not eligible — minor damage", "$0.00")
            finishSession(finalBags)
            setScreen("home")
          }}
          addAnotherBag={() => {
            finalizeActiveBag("minor", "Not eligible — minor damage", "$0.00")
            startNextBag()
          }}
        />
      )}
      {screen === "offer" && (
        <Offer
          bagId={activeBagId}
          back={() => setScreen("upload")}
          type={compensation}
          onTypeChange={setCompensation}
          bagImage={bagImage}
          traveler={traveler}
          locked={uploadedImages.length === 0}
          accept={() => {
            finalizeActiveBag("major", "Accepted standard offer", compensationDetails[compensation].amount)
            setScreen("accepted")
          }}
          reject={() => setScreen("receipt")}
        />
      )}
      {screen === "accepted" && (
        <Accepted
          bagId={bags[bags.length - 1]?.id ?? activeBagId}
          back={() => setScreen("offer")}
          type={compensation}
          onTypeChange={setCompensation}
          bagImage={bags[bags.length - 1]?.images[1] ?? bagImage}
          traveler={traveler}
          addBag={startNextBag}
          continueFlow={() => {
            finishSession(bags)
            setScreen("home")
          }}
        />
      )}
      {screen === "receipt" && (
        <Receipt
          bagId={activeBagId}
          back={() => setScreen("offer")}
          type={compensation}
          onTypeChange={setCompensation}
          bagImage={bagImage}
          traveler={traveler}
          locked={uploadedImages.length === 0}
          onAddAnotherBag={() => {
            finalizeActiveBag(
              "major",
              "Rejected offer — receipt submitted",
              postReceiptDetails[compensation].amount,
            )
            startNextBag()
          }}
          onContinueToTransfer={() => {
            finalizeActiveBag(
              "major",
              "Rejected offer — receipt submitted",
              postReceiptDetails[compensation].amount,
            )
            setScreen("transfer")
          }}
        />
      )}
      {screen === "transfer" && (
        <TransferDetails
          type={compensation}
          traveler={traveler}
          back={() => setScreen("receipt")}
          submit={() => {
            finishSession(bags)
            setScreen("success")
          }}
        />
      )}
      {screen === "success" && <Success type={compensation} />}
      {scanning && (
        <ScanModal
          cancel={() => setScanning(false)}
          manualFallback={() => {
            setScanning(false)
            setScreen("manual")
          }}
          onScanned={async (bookingRef, lastName) => {
            const found = await handleSearch(bookingRef, lastName)
            if (found) setScanning(false)
            return found
          }}
        />
      )}
    </>
  )
}
