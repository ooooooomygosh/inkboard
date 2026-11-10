-- InkBoard: read recent work/school mail from Apple Mail. {{DAYS}} is replaced with the look-back window,
-- {{DOMAIN}} with MAIL_DOMAIN from ~/.inkboard/config.env (install.sh fills it in; empty = every inbox message).
-- Some school / company accounts cannot sign in to Apple Mail, so their mail is redirected (a rule in the
-- web mail) to any mailbox that IS signed in here. A message counts when the account itself belongs to
-- the domain, or it was sent to / from an address in it.
set US to character id 31
set RS to character id 30
set out to ""
tell application "Mail"
  set cutoff to (current date) - ({{DAYS}} * days)
  repeat with acc in accounts
    set accAddrs to (email addresses of acc) as string
    set isOrg to (accAddrs contains "{{DOMAIN}}")
    repeat with mb in (mailboxes of acc)
      set n to name of mb
      if n is "Inbox" or n is "INBOX" or n is "收件箱" then
        set msgs to (messages of mb whose date received > cutoff)
        set k to 0
        repeat with m in msgs
          set keep to isOrg
          if not keep then
            try
              set rcpt to ""
              repeat with r in (to recipients of m)
                set rcpt to rcpt & (address of r) & " "
              end repeat
              repeat with r in (cc recipients of m)
                set rcpt to rcpt & (address of r) & " "
              end repeat
              if rcpt contains "{{DOMAIN}}" or (sender of m) contains "{{DOMAIN}}" then set keep to true
            end try
          end if
          if keep then
            set k to k + 1
            if k > 40 then exit repeat
            set body to ""
            try
              set body to content of m
              if (length of body) > 1600 then set body to text 1 thru 1600 of body
              -- keep line breaks as a marker: the server needs them to unpack forwarded mail
              set AppleScript's text item delimiters to {return & linefeed, return, linefeed}
              set parts to text items of body
              set AppleScript's text item delimiters to " ⏎ "
              set body to parts as text
              set AppleScript's text item delimiters to ""
            end try
            set out to out & (message id of m) & US & (sender of m) & US & (subject of m) & US & ((date received of m) as «class isot» as string) & US & (read status of m as string) & US & body & RS
          end if
        end repeat
      end if
    end repeat
  end repeat
end tell
return out
