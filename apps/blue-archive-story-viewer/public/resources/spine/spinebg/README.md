# Locally hosted story Spine resources

`SC11000_01` is used by story background `SpineBG_SC11000_01`. The upstream
Yuuka resource CDN does not currently contain the corresponding Spine files,
so the Viewer publishes this complete Spine 4.2.33 resource set through its
existing Cloudflare Pages deployment. The player still tries its shared CDN
routes first and uses this copy only after those routes fail.

The binary texture and skeleton files are materialized into this directory by
`tools/ensure-local-spine-resources.mjs` before Vite or the Story Workbench
starts. They are verified against the hashes below and intentionally ignored
by Git because GitHub does not accept new LFS objects in public forks. The
atlas is small and remains tracked.

Source: `SunsetMkt/blue-archive-spine-production`, commit
`427f96368c397bffae64be45afeaf383502c049c`, path
`assets/spine/spinebg/`.

SHA-256:

- `SC11000_01.atlas`: `d92b31adc5cd692dbea80f000c46c4132781ed46ea8ea36c3896c18c13b2447c`
- `SC11000_01.skel`: `200878a716098fa4327b7ba065d940e2d18968f3da76bf7025967d036b43aec4`
- `SC11000_01.png`: `f403e8999d6020c770b9523690316ac4325ea342c15369e4011d68d9f7762c0a`
- `SC11000_01_2.png`: `2b1625b63e1573beda8c802e5e5ac060fdc4e57efd72a895c3eb02428a2fe060`
