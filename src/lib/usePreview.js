// Copyright (C) 2026 HidayahTech, LLC
// Preview state hook — manages all preview lifecycle: signed URL generation, text fetch,
// URL caching, and copy-link popover state.
//
// T4-2: every await is followed by `if (gen !== genRef.current) return` to cancel stale
// async callbacks when the user opens a new preview before the previous one resolves.
import { useState, useRef, useEffect } from 'preact/hooks';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { mediaKind, mimeType, mimeKind } from './media.js';

const PRESIGN_EXPIRES = 3600;
const TEXT_PREVIEW_LIMIT = 100 * 1024;

export function usePreview(client, bucket) {
  const [previewItem,          setPreviewItem]          = useState(null);
  const [previewUrl,           setPreviewUrl]           = useState(null);
  const [previewError,         setPreviewError]         = useState(null);
  const [resolvedKind,         setResolvedKind]         = useState(null);
  const [notPreviewable,       setNotPreviewable]       = useState(false);
  const [detectedContentType,  setDetectedContentType]  = useState(null);
  const [previewText,          setPreviewText]          = useState(null);
  const [previewTruncated,     setPreviewTruncated]     = useState(false);
  const [previewPixelated,     setPreviewPixelated]     = useState(false);
  const [previewCopyOpen,      setPreviewCopyOpen]      = useState(false);
  const [previewCopied,        setPreviewCopied]        = useState(false);

  const previewUrlCacheRef = useRef(new Map()); // key → { url, expiresAt, kind, contentType, text?, truncated? }
  const previewCopyWrapRef = useRef(null);
  const genRef             = useRef(0);         // incremented per handlePreview call; cancels stale async callbacks

  useEffect(() => {
    if (!previewCopyOpen) return;
    function onDown(e) {
      if (previewCopyWrapRef.current && !previewCopyWrapRef.current.contains(e.target)) {
        setPreviewCopyOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [previewCopyOpen]);

  async function handlePreview(obj) {
    const gen = ++genRef.current;

    setPreviewItem(obj);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewTruncated(false);
    setPreviewPixelated(false);
    setPreviewError(null);
    setResolvedKind(null);
    setNotPreviewable(false);
    setDetectedContentType(null);
    setPreviewCopyOpen(false);
    setPreviewCopied(false);

    try {
      const cached = previewUrlCacheRef.current.get(obj.Key);
      if (cached && Date.now() < cached.expiresAt) {
        if (gen !== genRef.current) return;
        setResolvedKind(cached.kind);
        if (cached.kind === 'text') {
          if (cached.text !== undefined) {
            setPreviewText(cached.text);
            setPreviewTruncated(cached.truncated ?? false);
          } else {
            const resp = await fetch(cached.url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } });
            if (gen !== genRef.current) return;
            setPreviewText(await resp.text());
            setPreviewTruncated(resp.status === 206);
          }
        } else {
          setPreviewUrl(cached.url);
        }
        return;
      }

      let kind, contentType;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.Key }));
        if (gen !== genRef.current) return;
        contentType = head.ContentType || '';
        kind = mimeKind(contentType) || mediaKind(obj.Key);
        if (!mimeKind(contentType) && mediaKind(obj.Key)) {
          contentType = mimeType(obj.Key) || contentType;
        }
      } catch {
        contentType = mimeType(obj.Key) || '';
        kind = mediaKind(obj.Key);
      }

      if (!kind) {
        if (gen !== genRef.current) return;
        setNotPreviewable(true);
        setDetectedContentType(contentType || null);
        return;
      }

      if (gen !== genRef.current) return;
      setResolvedKind(kind);

      const expiresAt = Date.now() + (PRESIGN_EXPIRES - 300) * 1000;

      if (kind === 'text') {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket, Key: obj.Key,
            ResponseContentDisposition: 'inline',
            ResponseContentType: 'text/plain; charset=utf-8',
          }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        previewUrlCacheRef.current.set(obj.Key, { url, expiresAt, kind, contentType });
        if (gen !== genRef.current) return;
        const resp = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` } });
        if (gen !== genRef.current) return;
        setPreviewText(await resp.text());
        setPreviewTruncated(resp.status === 206);
      } else {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket, Key: obj.Key,
            ResponseContentDisposition: 'inline',
            ...(contentType ? { ResponseContentType: contentType } : {}),
          }),
          { expiresIn: PRESIGN_EXPIRES },
        );
        previewUrlCacheRef.current.set(obj.Key, { url, expiresAt, kind, contentType });
        if (gen !== genRef.current) return;
        setPreviewUrl(url);
      }
    } catch (err) {
      if (gen !== genRef.current) return;
      setPreviewError(err);
    }
  }

  function closePreview() {
    setPreviewItem(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewTruncated(false);
    setPreviewPixelated(false);
    setPreviewError(null);
    setResolvedKind(null);
    setNotPreviewable(false);
    setDetectedContentType(null);
    setPreviewCopyOpen(false);
    setPreviewCopied(false);
  }

  return {
    previewItem,
    previewUrl,
    previewError,
    resolvedKind,
    notPreviewable,
    detectedContentType,
    previewText,
    previewTruncated,
    previewPixelated,    setPreviewPixelated,
    previewCopyOpen,     setPreviewCopyOpen,
    previewCopied,       setPreviewCopied,
    previewUrlCacheRef,
    previewCopyWrapRef,
    handlePreview,
    closePreview,
  };
}
