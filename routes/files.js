// Download links for uploaded files.
// Files live on Cloudinary. Public delivery links can be blocked for PDFs,
// so instead of handing out that link, the server asks Cloudinary for a
// signed, short-lived download link and gives that to the logged-in user.
const express = require("express");
const { v2: cloudinary } = require("cloudinary");
const { requireLogin } = require("../auth");

const router = express.Router();
router.use(requireLogin);

// Splits a Cloudinary link into what the download call needs:
// https://res.cloudinary.com/<cloud>/<image|raw>/upload/v123/sms/1725-42.pdf
function parseCloudinaryUrl(link) {
  let u;
  try { u = new URL(link); } catch (e) { return null; }

  if (u.hostname !== "res.cloudinary.com") return null;

  const m = u.pathname.match(/^\/([^/]+)\/(image|raw|video)\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+)$/);
  if (!m) return null;

  // Only our own account's files may be signed.
  if (process.env.CLOUDINARY_CLOUD_NAME && m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return null;

  return { resourceType: m[2], rest: decodeURIComponent(m[3]) };
}

// GET /api/files/link?url=<the stored Cloudinary link>
router.get("/link", function (req, res) {
  const link = String(req.query.url || "");
  const parsed = parseCloudinaryUrl(link);
  if (!parsed) return res.status(400).json({ message: "That is not a file stored by this school." });

  try {
    let publicId = parsed.rest;
    let format;

    // Photos are stored without their extension in the name, so it is sent
    // separately. PDFs and Word files (raw) keep the extension in the name.
    if (parsed.resourceType !== "raw") {
      const dot = publicId.lastIndexOf(".");
      if (dot > 0) {
        format = publicId.slice(dot + 1);
        publicId = publicId.slice(0, dot);
      }
    }

    const signed = cloudinary.utils.private_download_url(publicId, format, {
      resource_type: parsed.resourceType,
      type: "upload",
      attachment: true,
      expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
    });

    res.json({ url: signed });
  } catch (err) {
    console.error("Could not sign download link:", err.message);
    res.status(500).json({ message: "Could not prepare the download." });
  }
});

module.exports = router;
