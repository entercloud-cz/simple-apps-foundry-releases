---
name: blob-storage
description: Use when the app needs to store or serve files - uploads, attachments, images, exports, generated PDFs or reports, imports - or anything that would otherwise be written to the container's disk. Covers Azure Blob Storage access with managed identity, containers, downloads through the app, short-lived download links, and upload validation.
---

# Blob Storage (files and uploads)

The container's disk is temporary and differs per replica. Files that must survive go to the
app's own Azure Storage account, requested in the portal. **No account keys, no connection
strings, no public containers:** shared-key access is disabled; the app uses its managed identity.

## What the platform provides

| Env var | Meaning |
|---|---|
| `STORAGE_BLOB_ENDPOINT` | `https://<account>.blob.core.windows.net/` |
| `AZURE_CLIENT_ID` | client id of the app's managed identity |

The identity can read and write blobs and create containers in this account only. Soft delete and
versioning are on (deleted or overwritten blobs can be restored for a limited time).

## Node/TS

```ts
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const credential = config.azureClientId
  ? new ManagedIdentityCredential({ clientId: config.azureClientId })
  : new DefaultAzureCredential();
const service = new BlobServiceClient(process.env.STORAGE_BLOB_ENDPOINT!, credential);
const container = service.getContainerClient('uploads');
await container.createIfNotExists();                    // once at startup; never public access

// upload: generated name, validated type and size
const name = `${request.user!.id}/${crypto.randomUUID()}`;
await container.getBlockBlobClient(name).uploadData(buffer, {
  blobHTTPHeaders: { blobContentType: detectedType },
  metadata: { originalName: encodeURIComponent(originalName) },
});

// download: through the app, after checking the user may see it
const download = await container.getBlobClient(name).download();
reply.header('Content-Type', download.contentType ?? 'application/octet-stream')
     .header('Content-Disposition', `attachment; filename="${safeFileName}"`);
return reply.send(download.readableStreamBody);
```

Add `@azure/storage-blob` with an exact version. Add `STORAGE_BLOB_ENDPOINT` to `config.ts` as an
optional setting and enable file features only when it is set. For uploads in Fastify use
`@fastify/multipart` with `limits: { fileSize: … , files: 1 }`.

## Python

```python
from azure.storage.blob import BlobServiceClient
service = BlobServiceClient(os.environ["STORAGE_BLOB_ENDPOINT"], credential=credential)  # same credential pattern
container = service.get_container_client("uploads")
container.upload_blob(name, data, content_settings=ContentSettings(content_type=detected_type))
```

## .NET

```csharp
var service = new BlobServiceClient(new Uri(config["STORAGE_BLOB_ENDPOINT"]!), credential);
var container = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync();               // PublicAccessType.None (default)
await container.GetBlobClient(name).UploadAsync(stream, new BlobHttpHeaders { ContentType = type });
```

## Serving files

Default: **stream through the app** (as above). Sign-in and permission checks then apply to every
download. Only for very large files consider a **user delegation SAS** (signed with the managed
identity, not a key): read-only, one blob, expiry ≤ 15 minutes, generated after the permission
check. Never account SAS, never long-lived links, never public containers.

## Upload rules

- Limit size (e.g. 10 MB) and count; reject early.
- Allow-list types and check the content (magic bytes), not just the extension or the
  browser-supplied `Content-Type`.
- Generate blob names (`<userId>/<uuid>`); keep the original name only as metadata, sanitised.
- Never execute, unzip or render uploaded files on the server without asking the platform team.
- Serve user files with `Content-Disposition: attachment` unless they are known-safe images.
- Store the blob name and owner in the database so permissions can be checked.

## Local development

Use Azurite (`mcr.microsoft.com/azure-storage/azurite:<pinned tag>`) or, if your account has
access, the nonprod account with `DefaultAzureCredential` after `az login`. Azurite needs its
well-known development connection string: use it only when `STORAGE_BLOB_ENDPOINT` points to
`127.0.0.1`, never on Azure.

## Common mistakes

- Writing uploads to `./uploads` or `/data` → lost on restart, not shared between replicas.
- Using `BlobServiceClient.fromConnectionString` with an account key → keys are disabled.
- Creating a container with public access, or returning raw blob URLs to the browser → they
  won't work (no anonymous access) and would leak data if they did.
- `AuthorizationPermissionMismatch` (403) → the identity lacks access to that account, or code
  uses a different account; check `STORAGE_BLOB_ENDPOINT` and ask the platform team.
- Reading the whole file into memory for large downloads → stream it.
