#!/usr/bin/env node
import http from 'http';

const PORT = parseInt(process.env.MOCK_S3_PORT ?? '9090', 10);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'ETag, x-amz-request-id, x-amz-id-2',
  'Access-Control-Max-Age': '86400',
};

function drain(req) {
  return new Promise(resolve => { req.resume(); req.on('end', resolve); });
}

function xml(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/xml' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    xml(res, 200, `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test-bucket</Name><Prefix></Prefix>
  <KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`);
    return;
  }

  if (req.method === 'POST' && url.searchParams.has('uploads')) {
    await drain(req);
    const key = url.pathname.split('/').slice(2).join('/');
    xml(res, 200, `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>test-bucket</Bucket><Key>${key}</Key>
  <UploadId>mock-${Date.now()}</UploadId>
</InitiateMultipartUploadResult>`);
    return;
  }

  if (req.method === 'POST' && url.searchParams.has('uploadId')) {
    await drain(req);
    const key = url.pathname.split('/').slice(2).join('/');
    xml(res, 200, `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>http://localhost:${PORT}${url.pathname}</Location>
  <Bucket>test-bucket</Bucket><Key>${key}</Key>
  <ETag>"mock-complete-${Date.now()}"</ETag>
</CompleteMultipartUploadResult>`);
    return;
  }

  if (req.method === 'PUT') {
    await drain(req);
    res.writeHead(200, { ...CORS, ETag: `"mock-${Date.now()}"` });
    res.end();
    return;
  }

  if (req.method === 'DELETE') {
    await drain(req);
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  res.writeHead(200, CORS);
  res.end();
});

server.listen(PORT, () => {
  process.stdout.write(`mock-s3 ready on http://localhost:${PORT}\n`);
});
