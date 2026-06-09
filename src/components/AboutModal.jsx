// Copyright (C) 2026 HidayahTech, LLC
// About modal — product overview and key differentiators.
import { useEffect } from 'preact/hooks';
import { Modal } from './Modal.jsx';

export function AboutModal({ onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <Modal onClose={onClose} class="about-dialog">
        <div class="modal-title">About Bucketer</div>
        <div class="about-body">

          <div class="about-section">
            <div class="about-heading">⚡ No install. No server. No backend. No third-party trust.</div>
            <p>Open a URL. Enter your credentials. You're managing your bucket. Close the tab when you're done — nothing lingers, nothing persists on a server you didn't ask for. There's no installation, no Docker container, no daemon to keep running. Just a URL.</p>
          </div>

          <div class="about-section">
            <div class="about-heading">🔒 The only thing you have to trust is your browser.</div>
            <p>There's no Bucketer backend. The webpage IS the app. The host serving it only knows you loaded it, and nothing else. It cannot observe which provider you're connecting to, which bucket you're in, or what credentials you used. Your secret key lives only in <code>sessionStorage</code> and is cleared when you close the tab. Every S3 request goes directly from your browser to your storage endpoint, signed in-browser with SigV4, over TLS.</p>
            <p>You already trust your browser. That's all Bucketer requires.</p>
          </div>

          <div class="about-section">
            <div class="about-heading">📄 One file. Runs anywhere a browser runs.</div>
            <p>The entire application — logic, styles, AWS SDK — ships as a single self-contained HTML file. Copy it to nginx. Drop it into the bucket you're managing. Deploy it to Cloudflare Pages, GitHub Pages, or a corporate intranet with no internet access. Open it directly as <code>file://</code> in Firefox. No build step on the server. No CDN calls at runtime. No external scripts fetched from anywhere.</p>
            <p>The file in the repository is the file that runs in your browser. You can audit it. You can build it yourself. What you deploy is exactly what you get.</p>
          </div>

          <div class="about-section">
            <div class="about-heading">🔄 Multipart upload resume — without a backend.</div>
            <p>Drop a 20 GB file. Your network drops. Your browser crashes. You close the tab by accident.</p>
            <p>Re-open the app. Re-add the file.</p>
            <p>Bucketer calls <code>ListParts</code> to ask your storage provider what was actually received, verifies the file by content hash, and continues uploading from the last confirmed part. No server. No daemon. No resume database to run. IndexedDB holds the session state across restarts, and the provider is the authoritative source on what landed.</p>
          </div>

          <div class="about-section">
            <div class="about-heading">🌐 Built for every S3-compatible API. Not just AWS.</div>
            <p>The AWS Console only works for AWS. Most third-party tools treat non-AWS providers as an afterthought. When MinIO stripped the management console from its community edition in 2025, users running self-hosted S3-compatible storage — MinIO, Garage, Ceph, SeaweedFS — were left without a web UI.</p>
            <p>Bucketer treats every S3-compatible API as first-class: Backblaze B2, Cloudflare R2, Wasabi, AWS S3, DigitalOcean Spaces, MinIO, and any generic endpoint. It auto-detects your provider from the endpoint URL and encodes per-provider differences where they actually matter — path-style vs. virtual-hosted routing, multipart session lifetimes, CORS setup, region handling. It even adjusts listing defaults based on billing: B2 charges per <code>ListObjects</code> call, so Bucketer pages at 200 results instead of 1,000. No surprise bills.</p>
            <p>Open source under AGPLv3. No console removal. No bait and switch.</p>
          </div>

          <p class="about-tagline"><strong>This is Bucketer</strong> — an in-browser S3-compatible bucket manager. Not five tools. One.</p>

          <div class="about-section about-author">
            <div class="about-heading">A note from the author</div>
            <p><em>Crafted with ❤️ and Claude Code by Basil Mohamed Gohar @ HidayahTech.</em></p>
            <p>I designed and implemented this over the course of a few weeks to solve a real problem I had and to be my first real deep dive into GenAI-assisted software development. At the time of this writing, I've been a software developer for over 20 years, but this is the first time I've used GenAI from start to finish in a complete application with real usability beyond my specific needs. I am grateful to say it's already found use by some people, so I decided to release it under the AGPL-3.0 license for others to benefit from it as well. I sincerely hope you find it useful or, at the very least, interesting. If you did, I'd welcome your honest, constructive feedback and I'll do my best to take it into consideration.</p>
            <p>🇵🇸 <strong>Free Palestine! End the Genocide and Occupation!</strong> 🇵🇸</p>
            <p>As more and more brands are implicated in genocide and other massive ethics violations, I felt that any effort, even if little more than a "drop in the bucket" (haaaaa...), was worth it, if for nothing else but my own soul's well-being. Further among my goals in writing this is that, in an era where more and more agency is being taken away from individuals, privacy is bought and sold like a commodity, and technology companies grow ever more hostile, I wanted to provide a tool that, while not by itself completely eliminating a reliance on big tech providers, gives the user back some agency.</p>
          </div>

        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
    </Modal>
  );
}
