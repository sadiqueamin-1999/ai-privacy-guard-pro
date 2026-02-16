# Alacrity-Hackathon-Team-6
Repository containing enterprise-grade, privacy-first AI governance layer that runs in the browser

AI Privacy Guard Pro – README
=============================

This file explains how to load, configure, and demonstrate all required features
of the AI Privacy Guard Pro browser extension, as aligned with the hackathon brief.

------------------------------------------------------------
1. Loading the Extension & Opening Extension Options
------------------------------------------------------------

1. Open chrome://extensions
2. Enable "Developer mode" (top-right corner)
3. Click "Load unpacked" and select this extension’s folder
4. Once loaded, click "Details" -> "Extension options"
5. You will now see the full configuration menu

------------------------------------------------------------
2. Detect Potential AI URLs
------------------------------------------------------------

1. In Extension Options:
   - Set "Track Users" -> Anonymized
   - Set "Track Prompts" -> Anonymized
   - In "Approved AI URL", paste:
       https://openrouter.ai/
   - Set "User Role" -> Finance
   - Ensure Profile is set to Confirm without any PIN

2. Click "Save Profile"

3. Click "Open AI Directory" to view the built‑in list of recognised AI sites.

4. Copy "chatgpt.com" from the directory and open it in the browser.

   -> A risk popup should appear.  
     Click "Proceed" to continue using the site.

5. Close chatgpt.com.

6. Go back to Extension Options:
   - Set Profile = Strict
   - Set Admin PIN = 1234
   - Click "Save Profile"

7. Open chatgpt.com again in a new window.

   -> You will now be asked for the PIN because the strict profile treats this usage as high‑risk.  
      Enter 1234 → click Proceed.

8. Close this window.

------------------------------------------------------------
3. Detect AI Usage Within Applications
------------------------------------------------------------

1. Set Profile = Confirm  
2. Remove the PIN  
3. Click "Save Profile"

4. Click "Open AI Directory"  
5. Copy "mail.google.com"  
6. Open it in the browser

   -> You should see a popup indicating in‑app AI usage

7. Tick "Always allow this site" -> click "Proceed"

8. Close and reopen mail.google.com

   -> No popup appears, because the site is now allowed.

NOTE:
You may select "Always block this site" instead.
Reopening will show “This site has been blocked by policy.”
In Confirm mode you can still proceed; in Strict you may require a PIN.

------------------------------------------------------------
4. Allowlist & Blocklist Behaviour
------------------------------------------------------------

IMPORTANT:
Allowlist and Blocklist entries are tied to the ACTIVE PROFILE.
Adding an entry in Confirm does NOT apply to Strict or Allow profiles.
Note: Allow just allows everything except the blocklisted sites

----------------------
Allowlist demonstration
----------------------

1. Set Profile = Strict  
2. PIN = 1234  
3. Click "Save Profile"

4. Add "claude.ai" to the Allowlist  
5. Click "Save Profile"

6. Open claude.ai

   -> No popup appears, even in Strict mode, because it is explicitly allowed.

7. Remove claude.ai from the Allowlist  
8. Click "Save Profile"

----------------------
Blocklist demonstration
----------------------

1. Switch Profile = Confirm  
2. Remove PIN  
3. Click "Save Profile"

4. Add "perplexity.ai" to Blocklist  
5. Click "Save Profile"

BEFORE opening the site:
The next requirement depends on this state.
Do NOT click proceed on the popup.

6. Open perplexity.ai

   -> You will see: "This site has been blocked by policy"
     (Blocklist forces Risk = 100, even in Confirm mode)
	 This takes us onto the next requirement.

------------------------------------------------------------
5. User Interaction (Pop‑Up or Redirect)
------------------------------------------------------------

Remember how we set Approved AI URL to: https://openrouter.ai/ and User Role to Finance?
We are going to use that now.

1. Right now you would be on the perplexity.ai page with the window telling you that the site has been blocked by policy, 
   in this case, we need to redirect users to an internal company approved AI site such as https://openrouter.ai/
2. Click on Use Approved AI  
3. You should now be redirected to this site

This meets the requirement:
“Guide the user to an approved internal AI environment.”

------------------------------------------------------------
6. Collect Logs / Signals (Metadata Only)
------------------------------------------------------------

1. Open Extension Options  
2. Click "Export Logs (JSON)"

3. A JSON file will download containing only metadata:
   - Timestamp
   - Domain
   - Interaction type (domain/UI)
   - Whether the popup appeared
   - Decision (proceed / cancel / redirect)
   - User role (Finance)
   - Anonymous user ID (UUID)

No content or sensitive text is recorded.

You may open the JSON file to inspect the captured interactions.

------------------------------------------------------------

A demonstration video is included in the repo showing all the above steps.

Kind regards,  
Sadique



