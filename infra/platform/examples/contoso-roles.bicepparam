// Fictional Contoso instance: custom delivery roles, deployed once per instance from the
// portal host environment's subscription (prod in the example). Placeholder IDs only.
using '../roles.bicep'

param prefix = 'contoso'
param environmentSubscriptionIds = [
  '00000000-0000-0000-0000-00000000a001'
  '00000000-0000-0000-0000-00000000b001'
]
