/**
 * EDIBELL's official contact details — the ONLY place they are defined.
 * Edit them here; the footer and the Contact Us section update automatically.
 */
export const CONTACT = {
  email: "edibell.connect@gmail.com",
  /** International format, digits only after the "+" (used for the tel: link). */
  phone: "+917019489702",
} as const;

/** "+917019489702" → "+91 70194 89702" (other formats are shown as entered). */
export function formatPhone(phone: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone.replace(/\s+/g, ""));
  return m ? `+91 ${m[1]} ${m[2]}` : phone;
}

export const mailtoHref = (email: string = CONTACT.email) => `mailto:${email}`;
export const telHref = (phone: string = CONTACT.phone) => `tel:${phone.replace(/[^\d+]/g, "")}`;
