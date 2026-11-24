// Random public flow used to test the skills: log in, add a product, check out.
export const config = {
  url: 'https://www.saucedemo.com/',
  title: 'Checkout in 30 seconds',
  subtitle: 'Login → add to cart → pay',
};

export default async ({ page, click, type, hover, shot, chapter }) => {
  await shot('login');
  await type('#user-name', 'standard_user');
  await type('#password', 'secret_sauce');
  await click('#login-button');
  await page.waitForURL('**/inventory.html');
  await shot('inventory');

  await chapter('Pick a product');
  await hover('.inventory_item_name >> text=Sauce Labs Backpack');
  await click('#add-to-cart-sauce-labs-backpack');
  await click('.shopping_cart_link');
  await shot('cart');

  await chapter('Check out');
  await click('#checkout');
  await type('#first-name', 'Ada');
  await type('#last-name', 'Lovelace');
  await type('#postal-code', '28001');
  await click('#continue');
  await shot('overview');
  await click('#finish');
  await page.getByText('Thank you for your order!').waitFor();
  await shot('done');
};
