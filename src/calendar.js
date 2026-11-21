// "Add to calendar" without any third-party service: an .ics file (Apple Calendar,
// Outlook, most Android calendars) and a Google Calendar template link.

const DURATION_MS = 2 * 60 * 60 * 1000; // dates get a 2h slot by default

const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** RFC 5545 wants lines folded at 75 octets. */
function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/**
 * event: { uid, title, start (ms), location, details, url }
 */
export function buildICS(event) {
  const end = event.start + DURATION_MS;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ABC Dates//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utc(Date.now())}`,
    `DTSTART:${utc(event.start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    event.location ? `LOCATION:${icsEscape(event.location)}` : null,
    `DESCRIPTION:${icsEscape(event.details)}`,
    event.url ? `URL:${event.url}` : null,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(event.title)}`,
    'TRIGGER:-PT2H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadICS(event, filename) {
  const blob = new Blob([buildICS(event)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function googleCalendarUrl(event) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${utc(event.start)}/${utc(event.start + DURATION_MS)}`,
    details: event.url ? `${event.details}\n\n${event.url}` : event.details,
  });
  if (event.location) params.set('location', event.location);
  return `https://calendar.google.com/calendar/render?${params}`;
}
