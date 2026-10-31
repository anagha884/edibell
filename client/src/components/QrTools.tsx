import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "@/i18n";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Camera, CameraOff, ImageUp, StopCircle } from "lucide-react";

/** Renders `value` as a scannable QR code. The value must be an opaque token – never personal data. */
export function QrImage({ value, size = 260, dimmed = false, label }: { value: string; size?: number; dimmed?: boolean; label?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: size * 2, color: { dark: "#102e29", light: "#ffffff" } })
      .then(url => { if (live) setSrc(url); })
      .catch(() => { if (live) setSrc(""); });
    return () => { live = false; };
  }, [value, size]);
  return <div className={`eb-qr ${dimmed ? "dim" : ""}`} style={{ width: size, height: size }}>
    {src ? <img src={src} width={size} height={size} alt={label ?? tr("Pickup QR code")}/> : <span className="eb-muted">{tr("Generating…")}</span>}
  </div>;
}

type CamState = "idle" | "starting" | "live" | "error";

function decodeImage(img: CanvasImageSource, w: number, h: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/**
 * Camera-based scanner with a built-in photo-upload fallback.
 * It only DECODES the code; the server decides whether the pickup is valid.
 */
export function QrScanner({ onCode, busy }: { onCode: (text: string) => void; busy: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const lastTick = useRef(0);
  const busyRef = useRef(busy);
  const onCodeRef = useRef(onCode);
  const [state, setState] = useState<CamState>("idle");
  const [error, setError] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  busyRef.current = busy;
  onCodeRef.current = onCode;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setState("idle");
  }, []);

  useEffect(() => stop, [stop]);

  const tick = useCallback(() => {
    const v = video.current;
    if (!v || !stream.current) return;
    const now = performance.now();
    if (now - lastTick.current > 140 && !busyRef.current && v.readyState >= 2 && v.videoWidth > 0) {
      lastTick.current = now;
      const scale = Math.min(1, 720 / v.videoWidth);
      const text = decodeImage(v, Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale));
      if (text) onCodeRef.current(text);
    }
    raf.current = requestAnimationFrame(tick);
  }, []);

  const start = async () => {
    setError(""); setUploadMsg("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setError(window.isSecureContext
        ? "This browser can't access a camera. Use the photo upload or type the pickup code instead."
        : "Camera access needs a secure (HTTPS) connection. Use the photo upload or type the pickup code instead.");
      return;
    }
    setState("starting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      stream.current = s;
      const v = video.current!;
      v.srcObject = s;
      v.setAttribute("playsinline", "true");
      await v.play();
      setState("live");
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      stream.current?.getTracks().forEach(t => t.stop());
      stream.current = null;
      const name = (e as DOMException)?.name;
      setState("error");
      setError(name === "NotAllowedError" || name === "SecurityError"
        ? "Camera permission was blocked. Allow camera access in your browser's site settings, or use the photo upload / manual code below."
        : name === "NotFoundError" || name === "OverconstrainedError"
          ? "No camera was found on this device. Use the photo upload or type the pickup code below."
          : "The camera couldn't be started. Use the photo upload or type the pickup code below.");
    }
  };

  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadMsg("");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const text = decodeImage(img, Math.round(img.width * scale), Math.round(img.height * scale));
      if (text) onCodeRef.current(text); else setUploadMsg(tr("No QR code was found in that picture. Try a sharper, closer photo."));
    } catch { setUploadMsg(tr("That file couldn't be read as an image.")); }
    finally { URL.revokeObjectURL(url); }
  };

  return <div className="eb-scanner">
    <div className={`eb-viewfinder ${state}`}>
      <video ref={video} muted playsInline aria-label={tr("Camera preview")}/>
      {state !== "live" && <div className="eb-viewfinder-idle">
        {state === "error" ? <CameraOff size={30}/> : <Camera size={30}/>}
        <p>{state === "starting" ? tr("Starting camera…") : state === "error" ? tr("Camera unavailable") : tr("Camera is off")}</p>
      </div>}
      {state === "live" && <div className="eb-reticle" aria-hidden="true"><i/><i/><i/><i/></div>}
    </div>
    {error && <p className="eb-error" role="alert">{tr(error)}</p>}
    <div className="eb-scanner-actions">
      {state === "live"
        ? <button type="button" className="button button-outline" onClick={stop}><StopCircle size={15}/>  {tr("Stop camera")}</button>
        : <button type="button" className="button" onClick={() => void start()} disabled={state === "starting"}><Camera size={15}/> {state === "error" ? tr("Try camera again") : tr("Start camera")}</button>}
      <label className="button button-outline eb-file-btn"><ImageUp size={15}/>  {tr("Upload QR photo")}<input type="file" accept="image/*" hidden onChange={e => { void fromFile(e.target.files?.[0]); e.target.value = ""; }}/></label>
    </div>
    {uploadMsg && <p className="eb-error" role="alert">{uploadMsg}</p>}
  </div>;
}
