# Android 7 compatibility root

`isrg_root_x1.pem` is the self-signed public ISRG Root X1 certificate, downloaded
from [Let's Encrypt](https://letsencrypt.org/certs/isrgrootx1.pem) on 2026-11-10.
It contains no private key. Its DER SHA-256 fingerprint is:

```
96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6
```

The plugin verifies that fingerprint, the CA flag, and the self-signature before
copying it into Android resources. Android 7.0 does not include this root; native
support begins at Android 7.1.1. See the official
[compatibility list](https://letsencrypt.org/docs/certificate-compatibility/) and
[root certificate details](https://letsencrypt.org/certificates/).

The additional trust applies only to `kaata.af` and its subdomains on Android
7.x. The `xml-v26` resource removes it on Android 8 and newer. System roots remain
available, so normal certificate renewal and a future CA change continue to work.
This is not certificate pinning and does not bypass certificate, hostname, or
expiry validation. Kaata domains require HTTPS. The existing cleartext setting
for other hosts is preserved so local development servers continue to work.

Do not replace this root with a leaf or intermediate certificate. Review its
continued trust and the supported Android versions when updating this plugin.
The official root details currently list a root-program trust horizon of June
2030, before the certificate's June 2035 `notAfter` date.
