Prompt Template:

************************************************************************
************************************************************************
************************************************************************

this mcp source is in this repo and has docs here @.vibemd and the saas control plane for it is in `~/ai.5pm.labs/labs-saas-ctrl` which has it's own `.vibemd/` docs; they both share the db model with tight RLS.

what would it take to support the following is it possible:

```

```

---

you must follow current networking, infrastructure, and security patterns as current features. you must consider both the mcp db model and the saas ctrl db model.

you must send frequent slack message embeds with status/progress updates and final results (even if have to stop) to channel id `C0APUJN1547` (these should be short/succinct/tl;dr, but use emojis). 

you must follow the rules in relative `.vibemd/RULES.md`.

************************************************************************
************************************************************************
************************************************************************

@.vibemd/ what would it take to support the following, is it possible:

```
you have local auth0 it's logged in with tenant `ai-5pm-labs`.

need to use auth0 as upstream idp for this remote mcp server.

this remote mcp server needs to support DCR. we need a robust solution for client proliferation in auth0.

use docker you have it locally: if you need quick store use redis, if you need db use postgres.

must be compatible with production version of the application. focus on Streamable HTTP (SHTTP) transport.

as a user, i should be able to run this mcp locally (but eventually in the cloud remotely) and authenticate to use it, so that i can connect to it from cursor or claude code or codex.
```

---

use the internet, use the context7 mcp, whatever you need to research so we can prove the plan.

you must follow the rules in `.vibemd/RULES.md`.

no code, just high level.

************************************************************************

@.vibemd what would it take to support the following, is it possible:

```
you have local gcloud cli it's logged in and project set to `ai-5pm-labs`.

we use cloudflare dns, with proxy enabled orange entries. we can't change the SSL/TLS encryption at this point it's currently ```

SSL/TLS encryption
Current encryption mode: Full

Full: Enable encryption end-to-end. Use this mode when your origin server supports SSL certification but does not use a valid, publicly trusted certificate.

```

this is intended to be served from `https://gamma.5pm.ai`

must be compatible with production version of the application. focus on Streamable HTTP (SHTTP) transport.

need to deploy to gcp to a us-east region closest to boston, ma. use a new and isolated vpc (you can delete the default one) that's locked down (e.g., firewall deny all ingress egress default, take out rdp), defense-in-depth, in future we will want to support this vpc can connect to another vpc in another project from the same gcp. redis/pg/cloudrun/etc must not have public ips, must not be exposed externally. leverage service accounts for roles/permissions/etc. enable the ssh thing i think it's iap and/or pga i should be able to ssh to bastion so you'll need to also spin up a small vm for it give it's own sa for example. use cloud nat and cloud router and negs and backends etc we'll need to support internal egress with or without static ips for possible upstream whitelisting, and also we need external load balancer such that we also want to support ingress to private services. finally another sa that can be used and attached so internal vms/runs/etc can egress to internet.
```

---

to research use the internet, use the context7 mcp, whatever you need to research so we can prove the plan.

you must follow the rules in `.vibemd/RULES.md`.

no code, just high level.

************************************************************************

