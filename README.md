# ManagerLens

Manager-first mutual fund analytics using verified AMC manager records, MFapi.in and AMFI.

## Direct AMFI-code support

- Enter a 4–9 digit AMFI scheme code for a fund or custom proxy.
- The code is validated against AMFI and MFapi before it is applied.
- If MFapi's ranged request returns no rows, the server retries the full history and filters dates locally.
- Invalid custom proxies do not trigger repeated background requests.
- The last valid dataset remains visible if a later refresh fails.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
