// Public endpoint -- no auth required, this is the site's contact form.
// Basic validation + rate-limit-worthy input size caps are enforced here
// server-side too, since client-side validation alone can always be bypassed.

const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 5000;
const VALID_SUBJECTS = ['General Enquiry', 'Buying a Gift Card', 'Selling a Gift Card', 'Report an Issue', 'Other'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    // Same fallback pattern as api/deliver-order.js -- works out of the box
    // via Resend's own test sender until a domain is verified and EMAIL_FROM
    // is set in Vercel.
    const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';
    const supportInbox = process.env.CONTACT_FORM_TO || 'support@giftlio.co.nz';

    if (!resendApiKey) {
        console.error('RESEND_API_KEY is not configured.');
        return res.status(500).json({ error: 'Email service is not configured.' });
    }

    const { name, email, subject, message } = req.body || {};

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > MAX_NAME_LENGTH) {
        return res.status(400).json({ error: 'Enter a valid name.' });
    }
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (typeof subject !== 'string' || !VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Select a valid subject.' });
    }
    if (typeof message !== 'string' || message.trim().length < 10 || message.trim().length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: 'Enter a message between 10 and 5000 characters.' });
    }

    const safeName = escapeHtml(name.trim());
    const safeEmail = escapeHtml(email.trim());
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message.trim()).replace(/\n/g, '<br>');

    const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
            <div style="background: #1B4D3E; padding: 20px; border-radius: 8px 8px 0 0;">
                <h2 style="color: #C45C26; margin: 0;">New Contact Form Message</h2>
            </div>
            <div style="padding: 20px; border: 1px solid #E8EAED; border-top: none; border-radius: 0 0 8px 8px;">
                <p><strong>From:</strong> ${safeName} (${safeEmail})</p>
                <p><strong>Subject:</strong> ${safeSubject}</p>
                <p><strong>Message:</strong></p>
                <p style="background: #F8F9FA; padding: 12px; border-radius: 6px;">${safeMessage}</p>
                <p style="color: #80868B; font-size: 12px; margin-top: 20px;">Reply directly to this email to respond to ${safeName}.</p>
            </div>
        </div>
    `;

    try {
        const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: emailFrom,
                to: supportInbox,
                reply_to: email.trim(),
                subject: `[Giftlio Contact] ${subject} — ${name.trim()}`,
                html: emailHtml
            })
        });

        if (!emailResponse.ok) {
            const errorBody = await emailResponse.text();
            console.error('Resend API error:', errorBody);
            throw new Error('Failed to send the email.');
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Failed to send contact form message:', error);
        return res.status(500).json({ error: 'Unable to send your message right now. Please email support@giftlio.co.nz directly.' });
    }
};
