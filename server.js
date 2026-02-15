const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/*
  PANEL LOGIN (stateless)
  Замість сесій — редірект на /panel/:venue/:pin
*/

app.get("/panel", (req, res) => {
  res.send(`
    <html>
    <body style="background:#0f1220;color:white;font-family:sans-serif;padding:40px;">
      <h2>Panel lokalu</h2>
      <form method="POST" action="/panel/login">
        <label>Venue ID</label><br/>
        <input name="venue" /><br/><br/>
        <label>PIN</label><br/>
        <input name="pin" /><br/><br/>
        <button type="submit">Zaloguj</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/panel/login", (req, res) => {
  const { venue, pin } = req.body;

  if (!venue || !pin) {
    return res.redirect("/panel");
  }

  // Просто редірект без сесій
  res.redirect(`/panel/${venue}/${pin}`);
});

app.get("/panel/:venue/:pin", (req, res) => {
  const { venue, pin } = req.params;

  res.send(`
    <html>
    <body style="background:#0f1220;color:white;font-family:sans-serif;padding:40px;">
      <h2>Panel lokalu</h2>
      <p>Zalogowano jako lokal: <b>${venue}</b></p>
      <p>PIN: <b>${pin}</b></p>
      <hr/>
      <h3>Wprowadź OTP</h3>
      <form method="POST" action="/panel/${venue}/${pin}/confirm">
        <input name="otp" placeholder="OTP" />
        <button type="submit">Confirm</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/panel/:venue/:pin/confirm", (req, res) => {
  const { venue } = req.params;
  const { otp } = req.body;

  res.send(`
    <html>
    <body style="background:#0f1220;color:white;font-family:sans-serif;padding:40px;">
      <h2>Confirm OK</h2>
      <p>Lokal: ${venue}</p>
      <p>OTP: ${otp}</p>
      <a href="/panel">Powrót</a>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
