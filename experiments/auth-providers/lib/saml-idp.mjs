// A lab SAML identity provider, reduced to the one thing a test needs from it:
// a signed SAML Response for a given AuthnRequest ID. Runs INSIDE a container
// (oven/bun) with xml-crypto installed there; nothing touches the host.
//
// spec (env SPEC_B64, base64 JSON): {
//   keyPem, certPem,           the IdP signing key and certificate in the SP's metadata
//   otherKeyPem,               a different key, used for variant "badsig"
//   issuer, audience, acs,     IdP entity ID; SP entity ID; SP assertion consumer URL
//   inResponseTo, email, sub,
//   variant: ok | badsig | wrongaud | expired | unsigned | wrongrecipient
// }
// prints RESULT:<base64 SAMLResponse>
import { SignedXml } from "xml-crypto";

const s = JSON.parse(Buffer.from(process.env.SPEC_B64 ?? "", "base64").toString("utf8"));
const id = (p) => `_${p}${crypto.randomUUID().replace(/-/g, "")}`;
const now = new Date();
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
const plus = (sec) => iso(new Date(now.getTime() + sec * 1000));

const expired = s.variant === "expired";
const notBefore = expired ? plus(-7200) : plus(-60);
const notOnOrAfter = expired ? plus(-3600) : plus(600);
const audience = s.variant === "wrongaud" ? "https://not-this-sp.example.com/metadata" : s.audience;
const recipient = s.variant === "wrongrecipient" ? "https://not-this-sp.example.com/acs" : s.acs;
const assertionId = id("a");
const responseId = id("r");

const attr = (name, value) =>
  `<saml:Attribute Name="${name}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:type="xs:string">${value}</saml:AttributeValue></saml:Attribute>`;

const assertion =
  `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso(now)}" Version="2.0">` +
  `<saml:Issuer>${s.issuer}</saml:Issuer>` +
  `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${s.email}</saml:NameID>` +
  `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${s.inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${recipient}"/></saml:SubjectConfirmation></saml:Subject>` +
  `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
  `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
  `<saml:AttributeStatement>${attr("email", s.email)}${attr("sub", s.sub)}</saml:AttributeStatement>` +
  `</saml:Assertion>`;

let signedAssertion = assertion;
if (s.variant !== "unsigned") {
  const sig = new SignedXml({
    privateKey: s.variant === "badsig" ? s.otherKeyPem : s.keyPem,
    publicCert: s.certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: "after" } });
  signedAssertion = sig.getSignedXml();
}

const response =
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" InResponseTo="${s.inResponseTo}" IssueInstant="${iso(now)}" Version="2.0" Destination="${s.acs}">` +
  `<saml:Issuer>${s.issuer}</saml:Issuer>` +
  `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
  signedAssertion +
  `</samlp:Response>`;

console.log("RESULT:" + Buffer.from(response).toString("base64"));
