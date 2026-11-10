# Licensing note: Windows for unattended automation

**This is not legal advice.** It records what we read in Microsoft's own terms and documentation about running
unattended automation on Windows, so that you know which questions to take to your licensing contact (your
Microsoft licensing partner, reseller or legal team). We read the sources on **10 November 2026** (UTC). Microsoft changes
its terms; read the current versions, and the agreement your organisation actually signed, which may differ from the
public pages. Where the sources below are unclear, this note says so and draws no conclusion.

The RPA desktop runner and browser are open source (MIT). They do not include any Windows licence, and nothing in
this project changes what your Windows licence allows.

## What the RPA package does that licensing may care about

- It runs **unattended**: the bot user's Windows session drives apps on behalf of n8n workflows, with nobody at the
  machine (section 4 of [the install guide](windows.md)).
- With `-AutoSignIn`, Windows signs the bot user in by itself at every start, and the machine is left signed in.
- People may reach the machine through **Remote Desktop**, to sign the bot user in or to watch it.
- n8n reaches the machine over the network (the runner on TCP 8765, the browser on TCP 3000).

## What we found

### Unattended bots that use the Windows desktop operating system

Microsoft's licensing guidance for the **Microsoft 365 Unattended License** says that "Any Unattended bot that
accesses Windows desktop OS or Microsoft 365 Apps must be licensed" with that licence. It defines an *attended* bot
as one that helps a person automate tasks on their workstation, started by that person's explicit actions, and counts
every other bot as *unattended*. One of its example scenarios has ten users who each run a third-party bot on their
desktops at night, and it counts ten Microsoft 365 Unattended Licenses and no Power Platform licence, since that
solution does not use Power Platform.

- Source: [Microsoft 365 Unattended License, Licensing Guidance](https://www.microsoft.com/licensing/guidance/Microsoft-365-Unattended-License)
  (Microsoft Licensing Resources; read 2026-11-10; the page shows no date).

The **Microsoft Product Terms** entry for the licence says that a customer may assign a Microsoft 365 A3/E3
Unattended License to an unattended bot running on hardware dedicated to the customer's use, on a virtual machine on
Azure (including Azure Virtual Desktop), or on Windows 365 Enterprise; that each licence covers "a single unique
physical or virtual OSE for Robotic Process Automation"; and that there is no Qualifying OS requirement for the suite.
It defines an unattended bot as "Any bot that does not strictly conform to the definition of 'Attended Bot'".

- Source: [Microsoft Product Terms, Microsoft 365 (Open License offering)](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/OL)
  (read 2026-11-10; the page's effective date field is blank).

Microsoft Learn's overview of unattended automation with Microsoft 365 Apps describes the same licence from the
Office side: without it, an Office app used by an unattended process runs in reduced functionality mode.

- Source: [Overview of the unattended robotic process automation with Microsoft 365 Apps for enterprise](https://learn.microsoft.com/en-us/microsoft-365-apps/licensing-activation/overview-unattended)
  (Microsoft Learn; article dated 2023-03-01, updated 2025-12-09; read 2026-11-10).

What is unclear to us from these sources:

- The guidance's sentence names the "Windows desktop OS", but the licence's terms speak of the Microsoft 365 A3/E3
  suite (which includes Windows Enterprise). The sources do not say in so many words whether a bot that uses only
  Windows itself, on a machine with its own Windows licence and without Microsoft 365 Apps, needs this licence, or
  whether another licence would do.
- They do not mention Windows Server. Whether the guidance applies to a bot on Windows Server is not stated.
- The hardware places the Product Terms list (dedicated hardware, Azure, Windows 365) do not name other clouds.

### Windows 10 and Windows 11 licence terms

The Windows licence terms (the version for Windows that came pre-installed on a device, last updated April 2024)
grant the right to run one instance "for use by one person at a time". They say that "device" does not include a
system "on which the software is installed or accessed solely for remote use over a network", and they do not allow
using the software "as server software", installing it "on a server for remote access or use over a network", or
installing it "on a device for use only by remote users". Their remote access clause lets one designated licensed
user access the device remotely, and other users "only on devices separately licensed to run the same or higher
edition".

- Source: [Microsoft Software License Terms, Windows Operating System, Windows 11, pre-installed](https://www.microsoft.com/content/dam/microsoft/usetm/documents/windows/11/oem-(pre-installed)/UseTerms_OEM_Windows_11_English.pdf)
  (last updated April 2024; read 2026-11-10). Other ways of buying Windows have other terms, listed at
  [microsoft.com/useterms](https://www.microsoft.com/useterms); these terms also say that a volume licence customer's
  use is governed by its volume licence agreement instead.

What is unclear to us: these terms do not mention automation or bots. Whether a machine that n8n drives over the
network, with nobody at it, is "accessed solely for remote use over a network", and who the "one person" is when a
bot user is signed in, are questions the terms do not answer directly.

### Remote Desktop to Windows Server

Microsoft's troubleshooting article on Remote Desktop says: "Remote Desktop supports two concurrent remote
connections to the computer. You do not have to have Remote Desktop Services client access licenses (RDS CALs) for
these connections. To allow more than two administrative connections or multiple user connections, you must install
the RD Session Host Role and have appropriate RDS CALs."

- Source: [Troubleshoot Remote desktop disconnected errors, section "Remote connections for administration"](https://learn.microsoft.com/en-us/troubleshoot/windows-server/remote/troubleshoot-remote-desktop-disconnected-errors)
  (Microsoft Learn; article dated 2026-02-12; read 2026-11-10).

Microsoft Learn's article on RDS licensing says: "Each user and device that connects to a Remote Desktop Services
session host or Azure Virtual Desktop session host running Windows Server needs a Remote Desktop Services (RDS)
client access license (CAL)."

- Source: [License Remote Desktop Services with Client Access Licenses (CALs)](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/rds-client-access-license)
  (Microsoft Learn; article dated 2025-06-16; read 2026-11-10).

Microsoft's licensing guidance on desktop applications and Windows Server Remote Desktop Services says that a Windows
Server CAL and an incremental RDS CAL are required "for each user or device using Windows Server Remote Desktop Services or
hosting a graphical user interface on Windows Server using Remote Desktop Services or similar functionality".

- Source: [Desktop Application Windows Server RDS, Licensing Guidance](https://www.microsoft.com/licensing/guidance/Desktop-Application-Windows-Server-RDS)
  (Microsoft Licensing Resources; read 2026-11-10; the page shows no date).

What is unclear to us: the two-connection allowance is described in a troubleshooting article as a technical limit
for administration; we did not find it in the Windows Server Product Terms page we read
([Windows Server Standard, Datacenter and Essentials](https://www.microsoft.com/licensing/terms/productoffering/WindowsServerStandardDatacenterEssentials/EAEAS),
read 2026-11-10), whose text available to us did not cover Remote Desktop Services. Whether a bot user that signs in
through Remote Desktop, or whose desktop people watch through Remote Desktop, counts as administration, and whether
an unattended session that n8n drives over the network is "similar functionality" to Remote Desktop Services, are not
answered by these sources.

## What to confirm with your licensing contact

1. Which licence covers an **unattended bot** that drives Windows apps on this machine: is a Microsoft 365
   Unattended License (or another licence) needed for each machine, given what is installed on it (Windows only, or
   Windows with Microsoft 365 Apps or other Microsoft software the bots drive)?
2. Whether the answer differs for **Windows Server** and for **Windows 10 or 11**, and for the way you bought each
   (pre-installed, retail, volume licensing, a cloud provider's image).
3. Whether the machine's **location** is allowed: your own hardware, hardware dedicated to you, Azure, or another
   cloud.
4. For **Windows 10 or 11**: whether a machine signed in as a bot user and driven over the network fits the terms'
   "one person at a time" and their limits on remote use.
5. For **Windows Server**: whether signing the bot user in, or watching it, through Remote Desktop needs **RDS
   CALs**, and whether the bot user itself needs a Windows Server CAL or an RDS CAL.
6. The licences of the **apps the bots drive**, which have their own terms on automated use.

Keep the answer with the machine's records, with the date and the version of the terms it was based on.
