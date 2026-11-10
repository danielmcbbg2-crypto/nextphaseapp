/**
 * Next Phase Maintenance: send Service.com.au job alerts to the portal.
 *
 * Runs in Google Apps Script (script.google.com) in the Gmail account that gets the alerts. Every
 * minute it looks for Service.com.au emails it hasn't sent on yet, posts each one to the portal's
 * service-leads function (which drafts a reply and texts the office a link), and labels it
 * "Portal/Service lead sent" so it's never sent twice.
 *
 * Setup: paste this into a new Apps Script project, put the intake key in INTAKE_KEY, choose
 * setup in the toolbar and click Run (Google asks you to allow Gmail access once). That's all.
 */
const INTAKE_KEY = 'PASTE-INTAKE-KEY-HERE'
const ENDPOINT = 'https://djgacgzmpmbrftkdlqrb.supabase.co/functions/v1/service-leads'
// Alerts come from Service.com.au; widen this if theirs arrive from another address.
const QUERY = 'from:service.com.au newer_than:2d -label:"Portal/Service lead sent"'
const LABEL = 'Portal/Service lead sent'

/** Run once: starts the every-minute check (and runs it now). */
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'checkServiceLeads') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('checkServiceLeads').timeBased().everyMinutes(1).create()
  checkServiceLeads()
}

function checkServiceLeads() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL)
  const threads = GmailApp.search(QUERY, 0, 20)
  threads.forEach((thread) => {
    let ok = true
    thread.getMessages().forEach((m) => {
      if (Date.now() - m.getDate().getTime() > 2 * 86400000) return
      // Only mail whose sender address really is @service.com.au (the search below also matches look-alikes).
      const addr = (m.getFrom().match(/<([^<>\s]+)>\s*$/) || [null, m.getFrom()])[1].trim().toLowerCase()
      if (!/^[^@\s<>]+@([a-z0-9-]+\.)*service\.com\.au$/.test(addr)) return
      const html = m.getBody()
      const links = []
      const re = /href\s*=\s*["']([^"']+)["']/gi
      let hit
      while ((hit = re.exec(html)) && links.length < 60) {
        const url = hit[1].replace(/&amp;/g, '&')
        if (/^https?:\/\//i.test(url) && links.indexOf(url) < 0) links.push(url)
      }
      const res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-intake-secret': INTAKE_KEY },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          action: 'intake',
          email: { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toString(), body: m.getPlainBody().slice(0, 20000), links },
        }),
      })
      const code = res.getResponseCode()
      console.log(m.getSubject() + ' -> ' + code + ' ' + res.getContentText().slice(0, 200))
      // A failure is tried again on the next run (the function never adds an email twice).
      if (code >= 500 || code === 401) ok = false
    })
    if (ok) thread.addLabel(label)
  })
}
