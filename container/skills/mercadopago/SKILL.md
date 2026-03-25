---
name: mercadopago
description: Create MercadoPago payment links to collect payments
allowed-tools: Bash(mercadopago:*)
---

# MercadoPago Payment Links

Create payment links to collect money via MercadoPago Checkout Pro.

## Usage

```bash
# Create a payment link
mercadopago create-link <amount> "<description>"

# Examples
mercadopago create-link 50 "Cooperacion por preguntar el modelo"
mercadopago create-link 100 "Servicio premium"
```

## Output

Returns a checkout URL that the user can open to pay. Send it via `send_message`.

## Important

- Amount is in MXN (Mexican pesos)
- Links expire after 24 hours
- Do NOT call the MercadoPago API directly — always use this script
